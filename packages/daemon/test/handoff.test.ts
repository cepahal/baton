import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BatonEvent, Handoff, HandoffsResponse, IngestServerMessage } from "@baton/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { resolveConfig, resolveServeConfig } from "../src/config.js";
import { type Daemon, startDaemon } from "../src/daemon.js";
import { ingestUrl } from "../src/remote-sink.js";
import { startTeamServer, type TeamServer } from "../src/team-server.js";
import { record, SESSION_A, SESSION_B, silent, tempProjects } from "./helpers.js";

async function until(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

let dirs: Awaited<ReturnType<typeof tempProjects>>;
const cleanups: (() => Promise<unknown>)[] = [];
beforeEach(async () => {
  dirs = await tempProjects();
});
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  await dirs.cleanup();
});

const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** Headers the confirm page's own fetches carry. */
const fromPage = (url: string, body: unknown) => {
  const host = new URL(url).host;
  return {
    method: "POST",
    headers: { "content-type": "application/json", host, origin: `http://${host}` },
    body: JSON.stringify(body),
  };
};

describe("text-only handoffs on a local daemon", () => {
  let daemon: Daemon;
  const launch = vi.fn(async () => {});

  beforeEach(async () => {
    launch.mockClear();
    await dirs.append(
      dirs.transcript(SESSION_A),
      `${record(SESSION_A, "user", "Build the cart page")}\n`,
    );
    await dirs.append(dirs.transcript(SESSION_B), `${record(SESSION_B, "user", "Fix the API")}\n`);
    const config = resolveConfig({
      port: 0,
      logLevel: "silent",
      recent: 0,
      summarizer: "off",
      projectsDir: dirs.projectsDir,
      codexDir: dirs.codexDir,
      stateFile: dirs.stateFile,
    });
    daemon = await startDaemon(config, silent, { notify: undefined, launch });
    cleanups.push(() => daemon.close());
    await until(
      () =>
        daemon.hub.session(SESSION_A) !== undefined && daemon.hub.session(SESSION_B) !== undefined,
      "both sessions",
    );
  });

  async function send(): Promise<Handoff> {
    const draft = await fetch(
      `${daemon.url}/handoffs/draft`,
      json({ kind: "full", fromSessionId: SESSION_A, toSessionId: SESSION_B, sender: "Ada" }),
    );
    expect(draft.status).toBe(200);
    const d = (await draft.json()) as Record<string, unknown>;
    expect(d).not.toHaveProperty("codeAvailable");
    expect(d.summarizer).toBe("heuristic");
    expect(String(d.markdown)).toContain("Build the cart page");
    const res = await fetch(
      `${daemon.url}/handoffs`,
      json({
        kind: "full",
        fromSessionId: SESSION_A,
        toSessionId: SESSION_B,
        markdown: d.markdown,
        sender: "Ada",
        // Old viewers may still send this; it is ignored.
        attachCode: true,
      }),
    );
    expect(res.status).toBe(201);
    const { handoff } = (await res.json()) as { handoff: unknown };
    return Handoff.parse(handoff);
  }

  async function listed(id: string) {
    const res = await fetch(`${daemon.url}/handoffs`);
    return HandoffsResponse.parse(await res.json()).handoffs.find((h) => h.id === id);
  }

  it("drafts and sends the whole chat without the summarizer", async () => {
    const draft = await fetch(
      `${daemon.url}/handoffs/draft`,
      json({ kind: "chat", fromSessionId: SESSION_A, toSessionId: SESSION_B, sender: "Ada" }),
    );
    expect(draft.status).toBe(200);
    const d = (await draft.json()) as Record<string, unknown>;
    expect(d.summarizer).toBe("none");
    expect(String(d.markdown)).toMatch(/^# Chat from Ada/);
    expect(String(d.markdown)).toContain("### Prompt\n\nBuild the cart page");
    const res = await fetch(
      `${daemon.url}/handoffs`,
      json({
        kind: "chat",
        fromSessionId: SESSION_A,
        toSessionId: SESSION_B,
        markdown: d.markdown,
        sender: "Ada",
      }),
    );
    expect(res.status).toBe(201);
    const h = Handoff.parse(((await res.json()) as { handoff: unknown }).handoff);
    expect(h.kind).toBe("chat");
    const page = await (await fetch(`${daemon.url}/inbox/${h.id}`)).text();
    expect(page).toContain("Whole chat from Ada");
  });

  it("sends text only and accepts by writing the file into the chosen folder", async () => {
    const h = await send();
    expect(h).not.toHaveProperty("code");
    const offer = daemon.handoffs.inbox.offer(h.id);
    expect(offer?.local).toBe("pending");
    const page = await (await fetch(`${daemon.url}/inbox/${h.id}`)).text();
    expect(page).toContain("Accept");
    expect(page).not.toMatch(/note|Apply code|Attach/i);

    const folder = await mkdtemp(join(tmpdir(), "baton-recv-"));
    cleanups.push(() => rm(folder, { recursive: true, force: true }));
    const url = `${daemon.url}/inbox/${h.id}/accept`;
    // Not from the confirm page: refused.
    expect((await fetch(url, json({ token: offer?.token, folder }))).status).toBe(403);
    // From the page, wrong token: refused.
    expect((await fetch(url, fromPage(url, { token: "nope", folder }))).status).toBe(403);
    const ok = await fetch(url, fromPage(url, { token: offer?.token, folder }));
    expect(ok.status).toBe(200);
    const written = await readFile(join(folder, ".baton", "handoffs", `${h.id}.md`), "utf8");
    expect(written).toContain("Build the cart page");
    expect(written).not.toContain("## Code");
    await until(async () => (await listed(h.id))?.status === "accepted", "accepted status");
    expect(launch).not.toHaveBeenCalled();
  });

  it("declines plainly: no note is kept or shown", async () => {
    const h = await send();
    const offer = daemon.handoffs.inbox.offer(h.id);
    const url = `${daemon.url}/inbox/${h.id}/decline`;
    const res = await fetch(url, fromPage(url, { token: offer?.token, note: "not now" }));
    expect(res.status).toBe(200);
    await until(async () => (await listed(h.id))?.status === "declined", "declined status");
    const after = await listed(h.id);
    expect(after).not.toHaveProperty("note");
    expect(JSON.stringify(after)).not.toContain("not now");
    // A second answer is refused.
    expect((await fetch(url, fromPage(url, { token: offer?.token }))).status).toBe(409);
  });

  it("offers a still-pending handoff again after a restart", async () => {
    const h = await send();
    await daemon.close();
    cleanups.pop();
    const config = resolveConfig({
      port: 0,
      logLevel: "silent",
      recent: 0,
      summarizer: "off",
      projectsDir: dirs.projectsDir,
      codexDir: dirs.codexDir,
      stateFile: dirs.stateFile,
    });
    daemon = await startDaemon(config, silent, { notify: undefined, launch });
    cleanups.push(() => daemon.close());
    // The inbox is in memory; the store isn't. Without a re-offer this 404s.
    expect(daemon.handoffs.inbox.offer(h.id)?.local).toBe("pending");
    expect((await fetch(`${daemon.url}/inbox/${h.id}`)).status).toBe(200);
  });

  it("no longer serves the code-sharing routes", async () => {
    const h = await send();
    const token = daemon.handoffs.inbox.offer(h.id)?.token;
    for (const path of [`/inbox/${h.id}/apply`, `/outbox/${h.id}/share`, `/outbox/${h.id}`]) {
      const url = `${daemon.url}${path}`;
      const res = path.endsWith(h.id)
        ? await fetch(url)
        : await fetch(url, fromPage(url, { token }));
      expect(res.status, path).toBe(404);
    }
  });
});

describe("handoffs when the summarizer fails", () => {
  async function draftWith(deps: Parameters<typeof startDaemon>[2], extra: object = {}) {
    await dirs.append(
      dirs.transcript(SESSION_A),
      `${record(SESSION_A, "user", "Build the cart page")}
`,
    );
    await dirs.append(
      dirs.transcript(SESSION_B),
      `${record(SESSION_B, "user", "Fix the API")}
`,
    );
    const config = resolveConfig({
      port: 0,
      logLevel: "silent",
      recent: 0,
      projectsDir: dirs.projectsDir,
      codexDir: dirs.codexDir,
      stateFile: dirs.stateFile,
      ...extra,
    });
    const daemon = await startDaemon(config, silent, {
      notify: undefined,
      launch: async () => {},
      ...deps,
    });
    cleanups.push(() => daemon.close());
    await until(
      () =>
        daemon.hub.session(SESSION_A) !== undefined && daemon.hub.session(SESSION_B) !== undefined,
      "both sessions",
    );
    const started = Date.now();
    const res = await fetch(
      `${daemon.url}/handoffs/draft`,
      json({ kind: "full", fromSessionId: SESSION_A, toSessionId: SESSION_B, sender: "Ada" }),
    );
    const body = (await res.json()) as Record<string, unknown>;
    // And it can still be sent.
    const sent = await fetch(
      `${daemon.url}/handoffs`,
      json({
        kind: "full",
        fromSessionId: SESSION_A,
        toSessionId: SESSION_B,
        markdown: body.markdown,
        sender: "Ada",
      }),
    );
    return { status: res.status, body, ms: Date.now() - started, sent: sent.status };
  }

  const expectHeuristic = (r: Awaited<ReturnType<typeof draftWith>>) => {
    expect(r.status).toBe(200);
    expect(r.body.summarizer).toBe("heuristic");
    expect(String(r.body.markdown)).toContain("Build the cart page");
    expect(r.sent).toBe(201);
  };

  it("drafts from the transcript when the summarizer throws", async () => {
    const r = await draftWith({
      summarize: async () => {
        throw new Error("boom");
      },
    });
    expectHeuristic(r);
    expect(String(r.body.warning)).toContain("wasn't available");
  });

  it("doesn't wait on a summarizer that never answers", async () => {
    const r = await draftWith({ summarize: () => new Promise(() => {}), summarizeTimeoutMs: 200 });
    expectHeuristic(r);
    expect(r.ms).toBeLessThan(5000);
  });

  it("moves on when Ollama isn't installed or running (the default summarizer)", async () => {
    // Nothing listens on port 9 (discard): the connection is refused.
    const r = await draftWith({}, { summarizer: "ollama", ollamaUrl: "http://127.0.0.1:9" });
    expectHeuristic(r);
  });
});

describe("handoff routing on a team server", () => {
  const TOKEN = "team-token-0123456789";
  let server: TeamServer;

  beforeEach(async () => {
    server = await startTeamServer(
      resolveServeConfig({
        host: "127.0.0.1",
        port: 0,
        token: TOKEN,
        logLevel: "silent",
        summarizer: "off",
        webDir: join(import.meta.dirname, "no-viewer"),
      }),
      silent,
    );
    cleanups.push(() => server.close());
  });

  /** A raw `/ingest` connection posing as a daemon. */
  async function fakeDaemon(name: string, sessionId?: string) {
    const messages: IngestServerMessage[] = [];
    const ws = new WebSocket(ingestUrl(server.url, name), {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    ws.on("message", (data) => {
      const parsed = IngestServerMessage.safeParse(JSON.parse(String(data)));
      if (parsed.success) messages.push(parsed.data);
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    cleanups.push(async () => ws.close());
    if (sessionId) {
      const event: BatonEvent = {
        id: `${sessionId}:1`,
        agent: "claude-code",
        sessionId,
        projectPath: `/home/${name}/proj`,
        ts: new Date(Date.UTC(2026, 10, 1)).toISOString(),
        seq: 1,
        kind: "prompt",
        text: `${name}'s work`,
      };
      ws.send(JSON.stringify({ type: "publish", batch: 1, events: [event] }));
      await until(() => messages.some((m) => m.type === "ack"), `${name}'s ack`);
    }
    const offers = () => messages.flatMap((m) => (m.type === "handoff_offer" ? [m] : []));
    return { ws, messages, offers };
  }

  const auth = (init: RequestInit = {}) => ({
    ...init,
    headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${TOKEN}` },
  });

  async function create(): Promise<Handoff> {
    const res = await fetch(
      `${server.url}/handoffs`,
      auth(
        json({
          kind: "full",
          fromSessionId: SESSION_A,
          toSessionId: SESSION_B,
          markdown: "# Handoff\nplease continue",
          sender: "Alice",
        }),
      ),
    );
    expect(res.status).toBe(201);
    return Handoff.parse(((await res.json()) as { handoff: unknown }).handoff);
  }

  async function status(id: string) {
    const res = await fetch(`${server.url}/handoffs`, auth());
    return HandoffsResponse.parse(await res.json()).handoffs.find((h) => h.id === id)?.status;
  }

  it("offers only to the receiving daemon and takes answers only from it", async () => {
    const alice = await fakeDaemon("alice", SESSION_A);
    const bob = await fakeDaemon("bob", SESSION_B);
    const mallory = await fakeDaemon("mallory");
    const h = await create();
    await until(() => bob.offers().length === 1, "bob's offer");
    const offer = bob.offers()[0];
    expect(offer?.handoff.id).toBe(h.id);
    expect(offer).not.toHaveProperty("patch");
    expect(alice.offers()).toHaveLength(0);
    expect(mallory.offers()).toHaveLength(0);

    mallory.ws.send(JSON.stringify({ type: "handoff_status", id: h.id, status: "accepted" }));
    alice.ws.send(JSON.stringify({ type: "handoff_status", id: h.id, status: "accepted" }));
    await new Promise((r) => setTimeout(r, 200));
    expect(await status(h.id)).toBe("pending");

    bob.ws.send(
      JSON.stringify({ type: "handoff_status", id: h.id, status: "declined", note: "x" }),
    );
    await until(async () => (await status(h.id)) === "declined", "declined");
  });

  it("resends a pending offer when the receiving daemon reconnects", async () => {
    await fakeDaemon("alice", SESSION_A);
    const bob = await fakeDaemon("bob", SESSION_B);
    bob.ws.close();
    await new Promise((r) => setTimeout(r, 100));
    const h = await create();
    const again = await fakeDaemon("bob");
    await until(() => again.offers().some((o) => o.handoff.id === h.id), "resent offer");
    expect(await status(h.id)).toBe("pending");
  });

  it("never serves the machine-local inbox", async () => {
    const res = await fetch(`${server.url}/inbox`, auth());
    expect(res.status).toBe(404);
  });
});

describe("Inbox", () => {
  it("resends its answer when the server re-offers a handoff it thinks is still pending", async () => {
    const { Inbox } = await import("../src/inbox.js");
    const report = vi.fn();
    const inbox = new Inbox({
      report,
      origin: () => "http://127.0.0.1:1",
      logger: silent,
      notify: undefined,
      newToken: () => "t",
    });
    const handoff = Handoff.parse({
      id: "habcdefghij",
      kind: "full",
      status: "pending",
      sender: "Ada",
      markdown: "# hi",
      from: { sessionId: SESSION_A, agent: "claude-code", repoId: null, branch: null },
      to: { sessionId: SESSION_B, agent: "claude-code", repoId: null, branch: null },
      createdAt: "2026-11-03T00:00:00.000Z",
      updatedAt: "2026-11-03T00:00:00.000Z",
    });
    inbox.receive({ type: "handoff_offer", handoff });
    // Re-offers before an answer change nothing.
    inbox.receive({ type: "handoff_offer", handoff });
    expect(report).not.toHaveBeenCalled();
    expect((await inbox.decline(handoff.id, "t")).ok).toBe(true);
    expect(report).toHaveBeenCalledTimes(1);
    // The answer was lost: the server offers it again as pending.
    inbox.receive({ type: "handoff_offer", handoff });
    expect(report).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenLastCalledWith({
      type: "handoff_status",
      id: handoff.id,
      status: "declined",
    });
    // Once the server knows, nothing more is sent.
    inbox.receive({ type: "handoff_offer", handoff: { ...handoff, status: "declined" } });
    expect(report).toHaveBeenCalledTimes(2);
  });
  it("accepts a folder typed with doubled separators or quotes", async () => {
    const { Inbox, cleanFolder } = await import("../src/inbox.js");
    const b = "\\";
    expect(cleanFolder(`C:${b}${b}Users${b}ada${b}repo`, "win32")).toBe(
      `C:${b}Users${b}ada${b}repo`,
    );
    expect(cleanFolder(`"C:${b}repo${b}"`, "win32")).toBe(`C:${b}repo${b}`);
    expect(cleanFolder("  '/home//ada/repo' ", "linux")).toBe("/home/ada/repo");

    // The lookup only knows the folder in its normal form, as git's root does.
    const checkout = await mkdtemp(join(tmpdir(), "baton-checkout-"));
    cleanups.push(() => rm(checkout, { recursive: true, force: true }));
    const lookup = vi.fn(async (dir: string) =>
      dir === checkout ? { root: checkout, repoId: "github.com/ada/repo" } : null,
    );
    const inbox = new Inbox({
      report: vi.fn(),
      origin: () => "http://127.0.0.1:1",
      logger: silent,
      notify: undefined,
      newToken: () => "t",
      foldersFile: join(checkout, "folders.json"),
      lookup,
    });
    const party = {
      sessionId: SESSION_A,
      agent: "claude-code",
      repoId: "github.com/ada/repo",
      branch: "main",
    };
    const handoff = Handoff.parse({
      id: "hfolderabcd",
      kind: "full",
      status: "pending",
      sender: "Ada",
      markdown: "# hi",
      from: party,
      to: { ...party, sessionId: SESSION_B },
      createdAt: "2026-11-03T00:00:00.000Z",
      updatedAt: "2026-11-03T00:00:00.000Z",
    });
    inbox.receive({ type: "handoff_offer", handoff });
    const sep = process.platform === "win32" ? b : "/";
    const typed = `"${checkout.replace(sep, sep + sep)}"`;
    const res = await inbox.accept(handoff.id, "t", typed);
    expect(lookup.mock.calls.map(([dir]) => dir)).toContain(checkout);
    expect(lookup.mock.calls.map(([dir]) => dir)).not.toContain(typed);
    expect(res).toMatchObject({ ok: true, checkout });
  });
});
