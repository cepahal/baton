import { expect, type Page, test } from "@playwright/test";
import {
  cutNetwork,
  eventsOf,
  expectedEvents,
  handoffs,
  type Machine,
  nodeOnMachine,
  onMachine,
  PNG,
  sessionOf,
  signIn,
  until,
} from "./stack.js";

// One stack, one story: each test builds on the last (cards placed, a note up).
test.describe.configure({ mode: "serial" });

const ids: Partial<Record<Machine, string>> = {};
const idOf = (m: Machine): string => {
  const id = ids[m];
  if (!id) throw new Error(`no session for ${m} yet`);
  return id;
};
const card = (page: Page, user: Machine) =>
  page.locator(".scard").filter({ has: page.locator(".scard-user", { hasText: user }) });

test.beforeAll(async () => {
  for (const m of ["alice", "bob", "grace"] as const) {
    ids[m] = await until(async () => (await sessionOf(m))?.sessionId, `${m}'s session`);
  }
});

test("teammates' sessions appear, labelled, and sessions in one repo are linked", async ({
  page,
}) => {
  await signIn(page);

  // The sidebar lists each machine's session under its daemon name.
  for (const m of ["alice", "bob", "grace"] as const) {
    await expect(page.locator(".session-group-name", { hasText: m })).toBeVisible();
  }
  // Nothing from the machine that shares nothing.
  await expect(page.locator(".session-group-name", { hasText: "mallory" })).toHaveCount(0);

  // Put the three on the canvas (the shared layout every viewer sees).
  const placed = await page.request.put("/canvas/positions", {
    data: {
      positions: {
        [`session:${idOf("alice")}`]: { x: 0, y: 0 },
        [`session:${idOf("bob")}`]: { x: 420, y: 0 },
        [`session:${idOf("grace")}`]: { x: 0, y: 420 },
      },
    },
  });
  expect(placed.status()).toBe(204);

  // Labels: who, which agent, and a domain chip on every card.
  await expect(card(page, "alice").locator(".agent-badge")).toHaveText(/Claude Code/);
  await expect(card(page, "grace").locator(".agent-badge")).toHaveText(/Codex/);
  for (const m of ["alice", "bob", "grace"] as const) {
    await expect(card(page, m).locator(".domain-chip")).toBeVisible();
  }

  // alice and bob work in github.com/acme/shop: one group box, linked to each other.
  const shop = page.locator(".repo-group", {
    has: page.locator(".repo-title", { hasText: "shop" }),
  });
  await expect(shop).toBeVisible();
  await expect(shop.locator(".repo-count")).toHaveText("2");
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
});

test("a sticky note with markdown and an image syncs to a second browser, inertly", async ({
  page,
  browser,
}) => {
  await signIn(page);
  // The note the server's 0.0.0 files held is on the canvas after the upgrade.
  await expect(page.locator("article.note", { hasText: "Kept across the upgrade" })).toBeVisible();
  const before = await page.locator("article.note").count();
  await page.getByRole("button", { name: "Add a sticky note" }).click();
  await expect(page.locator("article.note")).toHaveCount(before + 1);
  const note = page.locator("article.note").nth(before);
  await expect(note).toBeVisible();

  await note.dblclick();
  await note
    .getByLabel("Note text")
    .fill("# Ship list\n\n- **API** done\n- <img src=x onerror=window.__pwned=1>");
  await note.getByLabel("Note text").press("Control+Enter");
  await note.locator('input[type="file"]').setInputFiles({
    name: "shot.png",
    mimeType: "image/png",
    buffer: PNG,
  });
  await expect(note.locator("h1")).toHaveText("Ship list");

  // A teammate's browser: same note, formatted, with the image actually loaded.
  const other = await browser.newContext();
  const teammate = await other.newPage();
  await signIn(teammate);
  const theirs = teammate.locator("article.note", {
    has: teammate.locator("h1", { hasText: "Ship list" }),
  });
  await expect(theirs).toBeVisible();
  await expect(theirs.locator("strong")).toHaveText("API");
  const img = theirs.locator("img.note-thumb");
  await expect(img).toBeVisible();
  await expect
    .poll(() => img.evaluate((el) => (el instanceof HTMLImageElement ? el.naturalWidth : 0)))
    .toBe(4);
  // The HTML in the note is text, and its handler never ran, in either browser.
  await expect(theirs).toContainText("<img src=x onerror=window.__pwned=1>");
  for (const p of [page, teammate]) {
    expect(await p.evaluate(() => "__pwned" in window)).toBe(false);
  }
  await other.close();
});

test("a snippet handoff sent from the viewer is accepted on the receiving machine", async ({
  page,
}) => {
  await signIn(page);
  // Open bob's feed and drag one of its events onto alice's card.
  await card(page, "bob").locator(".scard-user").click();
  const column = page.locator("section.column");
  await expect(column).toBeVisible();
  const event = column.locator(".feed-drag").first();
  await expect(event).toBeVisible();
  await event.dragTo(card(page, "alice"));

  const dialog = page.getByRole("dialog", { name: "Hand off" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Handoff text")).not.toHaveValue("");
  await dialog.getByPlaceholder("shown to the receiver").fill("e2e");
  await dialog.getByRole("button", { name: "Send handoff" }).click();
  await expect(dialog).toBeHidden();

  const sent = await until(
    async () =>
      (await handoffs()).find((h) => h.kind === "snippet" && h.to.sessionId === idOf("alice")),
    "the handoff on the server",
  );
  expect(sent.status).toBe("pending");

  // On alice's machine, alice opens the confirm page on her own 127.0.0.1 and accepts.
  const answer = nodeOnMachine("alice", acceptScript(sent.id));
  expect(JSON.parse(answer)).toMatchObject({ ok: true });
  onMachine("alice", `test -f /work/shop/.baton/handoffs/${sent.id}.md`);

  // The sender's viewer hears back.
  await expect
    .poll(async () => (await handoffs()).find((h) => h.id === sent.id)?.status)
    .toBe("accepted");
  const tray = page.locator(".handoff-tray");
  if (await tray.evaluate((el) => el.classList.contains("is-closed"))) {
    await tray.locator(".handoff-tray-head").click();
  }
  await expect(tray.locator(".handoff-status.is-accepted").first()).toBeVisible();
});

test("a dropped daemon reconnects and its session carries on, exactly once", async ({ page }) => {
  await signIn(page);
  const bob = idOf("bob");
  const want = expectedEvents("bob");
  const before = (await eventsOf(bob)).length;
  test.skip(before >= want, "bob's replay finished before the drop; nothing to resume");

  // Kill bob's daemon (its supervisor loop restarts it), and cut his machine off for 10 s.
  onMachine("bob", "kill -9 $(cat /data/daemon.pid)");
  await cutNetwork("bob", 10_000);

  // Everything arrives, once, in order, and the viewer still shows one card for bob.
  await until(async () => (await eventsOf(bob)).length >= want, "bob's whole session", 180_000);
  const events = await eventsOf(bob);
  expect(events).toHaveLength(want);
  expect(events.map((e) => e.event.seq)).toEqual([...Array(want).keys()]);
  await expect(card(page, "bob")).toHaveCount(1);
  // bob's row in the sidebar (by his session id; another row may have the same count).
  const row = page.locator(".session", { hasText: bob.slice(0, 6) });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(`${want} events`);
});

/** What alice's confirm page does when she presses Accept, run on her machine. */
function acceptScript(id: string): string {
  return `
import http from "node:http";
const ID = ${JSON.stringify(id)};
const call = (method, path, body) => new Promise((resolve, reject) => {
  const data = body === undefined ? undefined : JSON.stringify(body);
  const req = http.request({ host: "127.0.0.1", port: 7777, path, method, headers: data ? {
    "content-type": "application/json", "content-length": Buffer.byteLength(data),
    origin: "http://127.0.0.1:7777" } : {} }, (res) => {
    let text = ""; res.on("data", (d) => (text += d)); res.on("end", () => resolve(text));
  });
  req.on("error", reject);
  req.end(data);
});
let page = "";
for (let i = 0; i < 60 && !page.includes("const TOKEN="); i++) {
  page = await call("GET", "/inbox/" + ID);
  if (!page.includes("const TOKEN=")) await new Promise((r) => setTimeout(r, 500));
}
const token = JSON.parse(page.match(/const TOKEN=("(?:[^"\\\\]|\\\\.)*")/)[1]);
let answer = JSON.parse(await call("POST", "/inbox/" + ID + "/accept", { token }));
// The page asks where the checkout is when it can't tell; alice types it in.
if (answer.needFolder) {
  answer = JSON.parse(await call("POST", "/inbox/" + ID + "/accept", { token, folder: "/work/shop" }));
}
process.stdout.write(JSON.stringify(answer));
`;
}
