import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BatonEvent,
  Handoff,
  HandoffAnswerError,
  HandoffResponse,
  HandoffsResponse,
  HandoffView,
  IngestServerMessage,
  PairCodeResponse,
} from "@baton/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { SESSION_COOKIE, sessionCookieValue } from "../src/auth.js";
import { resolveConfig, resolveServeConfig } from "../src/config.js";
import { type Daemon, startDaemon } from "../src/daemon.js";
import { gitExec } from "../src/git-exec.js";
import { runHandoffApply } from "../src/handoff-commands.js";
import { Inbox } from "../src/inbox.js";
import { newMachineId } from "../src/machine-id.js";
import { PairingStore } from "../src/pairing-store.js";
import { ingestUrl } from "../src/remote-sink.js";
import { lookupRepo } from "../src/repo-info.js";
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

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

/** Runs git, failing the test on a non-zero exit. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await gitExec(cwd, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=t@example.test",
    ...args,
  ]);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** A checkout with one commit and the given remote. */
async function repo(prefix: string, remote: string, files: Record<string, string>) {
  const dir = await tempDir(prefix);
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "remote", "add", "origin", remote);
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "first");
  return dir;
}

const handoffFile = (folder: string, id: string) => join(folder, ".baton", "handoffs", `${id}.md`);
const patchFile = (folder: string, id: string) =>
  join(folder, ".baton", "handoffs", id, "changes.patch");

describe("handoffs on a local daemon", () => {
  let daemon: Daemon;
  /** Where the receiving session (B) works. */
  let receiverDir: string;

  async function startWith(senderCwd: string, receiverCwd: string) {
    await dirs.append(
      dirs.transcript(SESSION_A),
      `${record(SESSION_A, "user", "Build the cart page", senderCwd)}\n`,
    );
    await dirs.append(
      dirs.transcript(SESSION_B),
      `${record(SESSION_B, "user", "Fix the API", receiverCwd)}\n`,
    );
    const config = resolveConfig({
      port: 0,
      logLevel: "silent",
      recent: 0,
      summarizer: "off",
      projectsDir: dirs.projectsDir,
      codexDir: dirs.codexDir,
      stateFile: dirs.stateFile,
    });
    daemon = await startDaemon(config, silent, { notify: undefined });
    cleanups.push(() => daemon.close());
    await until(
      () =>
        daemon.hub.session(SESSION_A) !== undefined && daemon.hub.session(SESSION_B) !== undefined,
      "both sessions",
    );
  }

  async function send(kind: "full" | "chat" = "full", attachCode = false): Promise<Handoff> {
    const draft = await fetch(
      `${daemon.url}/handoffs/draft`,
      json({ kind, fromSessionId: SESSION_A, toSessionId: SESSION_B, sender: "Ada" }),
    );
    expect(draft.status).toBe(200);
    const d = (await draft.json()) as Record<string, unknown>;
    expect(String(d.markdown)).toContain("Build the cart page");
    const res = await fetch(
      `${daemon.url}/handoffs`,
      json({
        kind,
        fromSessionId: SESSION_A,
        toSessionId: SESSION_B,
        markdown: d.markdown,
        sender: "Ada",
        ...(attachCode ? { attachCode: true } : {}),
      }),
    );
    expect(res.status).toBe(201);
    return HandoffResponse.parse(await res.json()).handoff;
  }

  const accept = (id: string, folder?: string) =>
    fetch(`${daemon.url}/handoffs/${id}/accept`, json(folder === undefined ? {} : { folder }));

  async function listed(id: string) {
    const res = await fetch(`${daemon.url}/handoffs`);
    return HandoffsResponse.parse(await res.json()).handoffs.find((h) => h.id === id);
  }

  describe("text handoffs", () => {
    beforeEach(async () => {
      receiverDir = await tempDir("baton-recv-");
      await startWith("/home/dev/sender", receiverDir);
    });

    it("drafts and sends the whole chat without the summarizer", async () => {
      const h = await send("chat");
      expect(h.kind).toBe("chat");
      expect(h.markdown).toMatch(/^# Chat from Ada/);
      expect(h.markdown).toContain("### Prompt\n\nBuild the cart page");
    });

    it("accepts into the receiving session's own folder by default", async () => {
      const h = await send();
      expect(h).not.toHaveProperty("code");
      const view = HandoffView.parse(
        await (
          await fetch(`${daemon.url}/handoffs/${h.id}`, { headers: { accept: "application/json" } })
        ).json(),
      );
      // The local viewer can only be opened on this machine: it answers for it.
      expect(view.canAnswer).toBe(true);

      const res = await accept(h.id);
      expect(res.status).toBe(200);
      const done = HandoffResponse.parse(await res.json()).handoff;
      expect(done.status).toBe("accepted");
      expect(done.delivery?.folder).toBe(receiverDir);
      expect(done.delivery?.apply).toEqual({
        available: false,
        reason: "The sender didn't attach code changes.",
      });
      const written = await readFile(handoffFile(receiverDir, h.id), "utf8");
      expect(written).toContain("Build the cart page");
      expect((await listed(h.id))?.status).toBe("accepted");
      // Answered once.
      expect((await accept(h.id)).status).toBe(409);
    });

    it("accepts into any folder the receiver names, git or not", async () => {
      const h = await send();
      const elsewhere = await tempDir("baton-other-");
      const res = await accept(h.id, `  "${elsewhere}"  `);
      expect(res.status).toBe(200);
      expect(await readFile(handoffFile(elsewhere, h.id), "utf8")).toContain("Build the cart page");
    });

    it("refuses a destination that isn't an existing folder, and asks for one", async () => {
      const h = await send();
      const missing = join(receiverDir, "nope");
      const res = await accept(h.id, missing);
      expect(res.status).toBe(409);
      const body = HandoffAnswerError.parse(await res.json());
      expect(body.needFolder).toBe(true);
      expect(body.error).toContain("is not a folder");
      const file = join(receiverDir, "a-file.txt");
      await writeFile(file, "x");
      expect((await accept(h.id, file)).status).toBe(409);
      expect((await accept(h.id, "relative/path")).status).toBe(409);
      expect((await listed(h.id))?.status).toBe("pending");
    });

    it("declines with a note the sender sees", async () => {
      const h = await send();
      const url = `${daemon.url}/handoffs/${h.id}/decline`;
      const res = await fetch(url, json({ note: "busy on the release, sorry" }));
      expect(res.status).toBe(200);
      const after = await listed(h.id);
      expect(after?.status).toBe("declined");
      expect(after?.note).toBe("busy on the release, sorry");
      expect((await fetch(url, json({}))).status).toBe(409);
      expect(daemon.handoffs.inbox.offer(h.id)).toBeUndefined();
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
      daemon = await startDaemon(config, silent, { notify: undefined });
      cleanups.push(() => daemon.close());
      // The inbox is in memory; the store isn't.
      expect(daemon.handoffs.inbox.offer(h.id)?.status).toBe("pending");
    });

    it("has no routes that start a terminal or apply a patch", async () => {
      const h = await send();
      for (const path of [
        `/inbox/${h.id}/accept`,
        `/inbox/${h.id}/start`,
        `/handoffs/${h.id}/start`,
        `/handoffs/${h.id}/apply`,
      ]) {
        expect((await fetch(`${daemon.url}${path}`, json({}))).status, path).toBe(404);
      }
      const inbox = daemon.handoffs.inbox as unknown as Record<string, unknown>;
      for (const method of ["start", "apply", "launch", "accept"]) {
        expect(inbox[method], method).toBeUndefined();
      }
    });
  });

  describe("code attachments", () => {
    const REMOTE = "https://github.com/ada/shop.git";
    let sender: string;

    beforeEach(async () => {
      sender = await repo("baton-sender-", REMOTE, { "cart.ts": "export const cart = [];\n" });
      // The uncommitted work that travels as changes.patch.
      await writeFile(
        join(sender, "cart.ts"),
        "export const cart = [];\nexport const total = 0;\n",
      );
      await writeFile(join(sender, "notes.md"), "todo: totals\n");
      receiverDir = await tempDir("baton-recv-");
      await startWith(sender, receiverDir);
      await until(
        () => daemon.hub.session(SESSION_A)?.repo?.repoId === "github.com/ada/shop",
        "the sender's repo",
      );
    });

    async function sendWithCode(): Promise<Handoff> {
      const h = await send("full", true);
      expect(h.code?.state).toBe("attached");
      expect(h.code?.files).toEqual(expect.arrayContaining(["cart.ts", "notes.md"]));
      expect(h.code?.base).toBe(await git(sender, "rev-parse", "HEAD"));
      return h;
    }

    it("writes changes.patch into a different repo, but doesn't offer to apply it", async () => {
      const h = await sendWithCode();
      const other = await repo("baton-other-", "https://github.com/bob/api.git", {
        "api.ts": "export {};\n",
      });
      const res = await accept(h.id, other);
      expect(res.status).toBe(200);
      const done = HandoffResponse.parse(await res.json()).handoff;
      expect(done.delivery?.apply.available).toBe(false);
      expect(done.delivery?.apply.reason).toContain("different repository");
      const patch = await readFile(patchFile(other, h.id), "utf8");
      expect(patch).toContain("+export const total = 0;");
      const md = await readFile(handoffFile(other, h.id), "utf8");
      expect(md).toContain(`.baton/handoffs/${h.id}/changes.patch`);
      // The handoff files stay out of git status.
      expect(await git(other, "status", "--porcelain")).toBe("");
    });

    it("writes changes.patch into a folder that isn't a checkout, without apply", async () => {
      const h = await sendWithCode();
      const plain = await tempDir("baton-plain-");
      const done = HandoffResponse.parse(await (await accept(h.id, plain)).json()).handoff;
      expect(done.delivery?.apply).toMatchObject({ available: false });
      expect(done.delivery?.apply.reason).toContain("isn't a git checkout");
      expect(await readFile(patchFile(plain, h.id), "utf8")).toContain("notes.md");
      // `baton handoff apply` refuses too.
      const err = { write: vi.fn() };
      expect(await runHandoffApply({ dir: plain, id: h.id }, { write: vi.fn() }, err)).toBe(1);
    });

    it("offers apply in a clone of the same repo, and `baton handoff apply` applies it", async () => {
      const h = await sendWithCode();
      const clone = await tempDir("baton-clone-");
      await git(clone, "clone", "-q", sender, ".");
      await git(clone, "remote", "set-url", "origin", REMOTE);
      expect((await lookupRepo(clone)).repoId).toBe("github.com/ada/shop");

      const done = HandoffResponse.parse(await (await accept(h.id, clone)).json()).handoff;
      expect(done.delivery?.apply).toEqual({ available: true });

      // A dirty tree is refused.
      await writeFile(join(clone, "cart.ts"), "local edit\n");
      const err = { write: vi.fn() };
      expect(await runHandoffApply({ dir: clone, id: h.id }, { write: vi.fn() }, err)).toBe(1);
      expect(String(err.write.mock.calls[0]?.[0])).toMatch(/uncommitted|dirty|clean/i);
      await git(clone, "checkout", "--", "cart.ts");

      const out = { write: vi.fn() };
      expect(await runHandoffApply({ dir: clone, id: h.id }, out, err)).toBe(0);
      expect(String(out.write.mock.calls[0]?.[0])).toContain(`baton/handoff-${h.id}`);
      expect(await git(clone, "branch", "--show-current")).toBe(`baton/handoff-${h.id}`);
      expect(await readFile(join(clone, "cart.ts"), "utf8")).toContain("export const total = 0;");
      expect(await readFile(join(clone, "notes.md"), "utf8")).toMatch(/^todo: totals\r?\n$/);
    });

    it("says why apply isn't offered when the base commit is missing", async () => {
      // Same repo, but the receiver's clone never fetched the sender's commit.
      const h = await sendWithCode();
      const clone = await repo("baton-stale-", REMOTE, { "cart.ts": "other history\n" });
      const done = HandoffResponse.parse(await (await accept(h.id, clone)).json()).handoff;
      expect(done.delivery?.apply.available).toBe(false);
      expect(done.delivery?.apply.reason).toContain("base commit");
    });
  });
});

describe("Inbox", () => {
  const party = (sessionId: string) => ({
    sessionId,
    agent: "claude-code" as const,
    repoId: null,
    branch: null,
  });
  const handoff = (id: string) =>
    Handoff.parse({
      id,
      kind: "full",
      status: "pending",
      sender: "Ada",
      markdown: "# hi",
      from: party(SESSION_A),
      to: party(SESSION_B),
      createdAt: "2026-11-03T00:00:00.000Z",
      updatedAt: "2026-11-03T00:00:00.000Z",
    });

  it("notifies with a link to the handoff's page on the team server", () => {
    const notify = vi.fn(async () => {});
    const inbox = new Inbox({ origin: () => "https://baton.example.test", logger: silent, notify });
    const h = handoff("hnotifyabcd");
    inbox.receive({ type: "handoff_offer", handoff: h });
    // Re-offers don't notify again.
    inbox.receive({ type: "handoff_offer", handoff: h });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://baton.example.test/handoffs/hnotifyabcd" }),
    );
    // Answered elsewhere: forgotten.
    inbox.receive({ type: "handoff_offer", handoff: { ...h, status: "declined" } });
    expect(inbox.offer(h.id)).toBeUndefined();
  });

  it("writes only handoffs it was offered", async () => {
    const folder = await tempDir("baton-inbox-");
    const inbox = new Inbox({ origin: () => "http://x", logger: silent, notify: undefined });
    const result = await inbox.write("hunknownabc", folder);
    expect(result.ok).toBe(false);
    expect(inbox.offer("hunknownabc")).toBeUndefined();
  });

  it("accepts a folder typed with doubled separators or quotes", async () => {
    const { cleanFolder } = await import("../src/inbox.js");
    const b = "\\";
    expect(cleanFolder(`C:${b}${b}Users${b}ada${b}repo`, "win32")).toBe(
      `C:${b}Users${b}ada${b}repo`,
    );
    expect(cleanFolder(`"C:${b}repo${b}"`, "win32")).toBe(`C:${b}repo${b}`);
    expect(cleanFolder("  '/home//ada/repo' ", "linux")).toBe("/home/ada/repo");
  });

  it("falls back to asking for a folder when the session's folder is unknown or gone", async () => {
    const inbox = new Inbox({
      origin: () => "http://x",
      logger: silent,
      notify: undefined,
      sessionDir: () => join(tmpdir(), "baton-definitely-missing-dir"),
    });
    const h = handoff("hmissingabc");
    inbox.receive({ type: "handoff_offer", handoff: h });
    const result = await inbox.write(h.id);
    expect(result).toMatchObject({ ok: false, needFolder: true });
  });
});

describe("handoffs on a team server", () => {
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

  type FakeDaemon = Awaited<ReturnType<typeof fakeDaemon>>;

  /**
   * A raw `/ingest` connection posing as a daemon. It answers `handoff_write`
   * like a real one would (or with `writeResult`), and records everything.
   */
  async function fakeDaemon(name: string, sessionId?: string, machine = newMachineId()) {
    const messages: IngestServerMessage[] = [];
    const ws = new WebSocket(ingestUrl(server.url, name, machine), {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    ws.on("message", (data) => {
      const parsed = IngestServerMessage.safeParse(JSON.parse(String(data)));
      if (!parsed.success) return;
      const m = parsed.data;
      messages.push(m);
      if (m.type === "handoff_write") {
        ws.send(
          JSON.stringify({
            type: "handoff_written",
            requestId: m.requestId,
            id: m.id,
            result: {
              ok: true,
              delivery: {
                folder: m.folder ?? `/home/${name}/proj`,
                path: `/home/${name}/proj/.baton/handoffs/${m.id}.md`,
                apply: { available: false, reason: "no code" },
              },
            },
          }),
        );
      }
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    cleanups.push(async () => ws.close());
    await until(() => messages.some((m) => m.type === "ingest_hello"), `${name}'s hello`);
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
    const of = <T extends IngestServerMessage["type"]>(type: T) =>
      messages.filter((m): m is Extract<IngestServerMessage, { type: T }> => m.type === type);
    const close = async () => {
      ws.close();
      await new Promise((r) => setTimeout(r, 100));
    };
    return { ws, name, machine, messages, of, close };
  }

  const bearer = { authorization: `Bearer ${TOKEN}` };

  /** A browser: logged in with the team token, and paired if it has a cookie. */
  const browser = (cookie?: string) => ({
    ...bearer,
    ...(cookie ? { cookie } : {}),
  });

  /** Pairs a new browser with `d`, the way `baton start --server` and the /pair page do. */
  async function pair(d: FakeDaemon): Promise<string> {
    const res = await fetch(
      `${server.url}/pair`,
      json({ name: d.name, machine: d.machine }, bearer),
    );
    expect(res.status).toBe(200);
    const { code } = PairCodeResponse.parse(await res.json());
    const claim = await fetch(`${server.url}/pair/claim`, json({ code }, browser()));
    expect(claim.status).toBe(200);
    const cookie = claim.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^baton_pair=[^;]+;.*HttpOnly/);
    return cookie.split(";")[0] ?? "";
  }

  async function create(): Promise<Handoff> {
    const res = await fetch(
      `${server.url}/handoffs`,
      json(
        {
          kind: "full",
          fromSessionId: SESSION_A,
          toSessionId: SESSION_B,
          markdown: "# Handoff\nplease continue",
          sender: "Alice",
        },
        bearer,
      ),
    );
    expect(res.status).toBe(201);
    return HandoffResponse.parse(await res.json()).handoff;
  }

  const accept = (id: string, cookie?: string, body: object = {}) =>
    fetch(`${server.url}/handoffs/${id}/accept`, json(body, browser(cookie)));
  const decline = (id: string, cookie?: string, body: object = {}) =>
    fetch(`${server.url}/handoffs/${id}/decline`, json(body, browser(cookie)));

  async function status(id: string) {
    const res = await fetch(`${server.url}/handoffs`, { headers: bearer });
    return HandoffsResponse.parse(await res.json()).handoffs.find((h) => h.id === id)?.status;
  }

  describe("pairing", () => {
    it("pairs a browser once per code, and GET /me says with which machine", async () => {
      const bob = await fakeDaemon("bob", SESSION_B);
      const unpaired = await fetch(`${server.url}/me`, { headers: browser() });
      expect(await unpaired.json()).toEqual({ local: false, pairing: null });

      const res = await fetch(
        `${server.url}/pair`,
        json({ name: "bob", machine: bob.machine }, bearer),
      );
      const { code } = PairCodeResponse.parse(await res.json());
      const first = await fetch(`${server.url}/pair/claim`, json({ code }, browser()));
      expect(first.status).toBe(200);
      const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0];
      // Single use.
      const again = await fetch(`${server.url}/pair/claim`, json({ code }, browser()));
      expect(again.status).toBe(410);
      expect(again.headers.get("set-cookie")).toBeNull();

      const me = await fetch(`${server.url}/me`, { headers: browser(cookie) });
      expect(await me.json()).toEqual({
        local: false,
        pairing: { name: "bob", machine: bob.machine },
      });
    });

    it("only gives codes to a daemon, for a machine that is connected", async () => {
      const bob = await fakeDaemon("bob", SESSION_B);
      // Not with a logged-in browser's cookie: only the bearer token a daemon holds.
      const asBrowser = await fetch(
        `${server.url}/pair`,
        json(
          { name: "bob", machine: bob.machine },
          { cookie: `${SESSION_COOKIE}=${sessionCookieValue(TOKEN)}` },
        ),
      );
      expect(asBrowser.status).toBe(403);
      const wrongMachine = await fetch(
        `${server.url}/pair`,
        json({ name: "bob", machine: newMachineId() }, bearer),
      );
      expect(wrongMachine.status).toBe(409);
    });

    it("expires codes after 10 minutes and keeps only hashes", () => {
      let now = 1_000_000;
      const store = new PairingStore({ now: () => now });
      const pairing = { name: "bob", machine: newMachineId() };
      const a = store.newCode(pairing);
      const b = store.newCode(pairing);
      now += 10 * 60 * 1000 - 1;
      expect(store.claim(a.code)?.pairing).toEqual(pairing);
      expect(store.claim(a.code)).toBeUndefined();
      now += 2;
      expect(store.claim(b.code)).toBeUndefined();
      expect(store.claim("not-a-code")).toBeUndefined();
    });

    it("keeps pairings across a restart, in a file of hashes", async () => {
      const file = join(await tempDir("baton-pairings-"), "team-pairings.json");
      const machine = newMachineId();
      const before = new PairingStore({ file, logger: silent });
      await before.load();
      const code = before.newCode({ name: "bob", machine }).code;
      const claimed = before.claim(code);
      await before.flush();
      const text = await readFile(file, "utf8");
      expect(text).not.toContain(code);
      expect(text).not.toContain(claimed?.id ?? "?");

      const after = new PairingStore({ file, logger: silent });
      await after.load();
      expect(after.lookup(claimed?.id)).toEqual({ name: "bob", machine });
    });

    it("re-pairing a browser forgets its old pairing", () => {
      const store = new PairingStore();
      const one = store.claim(store.newCode({ name: "bob", machine: newMachineId() }).code);
      expect(one).toBeDefined();
      const two = store.claim(
        store.newCode({ name: "carol", machine: newMachineId() }).code,
        one?.id,
      );
      expect(store.lookup(one?.id)).toBeNull();
      expect(store.lookup(two?.id)?.name).toBe("carol");
    });
  });

  describe("accept and decline", () => {
    it("lets only a browser paired with the receiving machine answer", async () => {
      const alice = await fakeDaemon("alice", SESSION_A);
      const bob = await fakeDaemon("bob", SESSION_B);
      const mallory = await fakeDaemon("mallory");
      const h = await create();
      await until(() => bob.of("handoff_offer").length === 1, "bob's offer");
      expect(alice.of("handoff_offer")).toHaveLength(0);
      expect(mallory.of("handoff_offer")).toHaveLength(0);

      // Unpaired: 403, and the page says how to pair.
      expect((await accept(h.id)).status).toBe(403);
      expect((await decline(h.id)).status).toBe(403);
      const view = HandoffView.parse(
        await (await fetch(`${server.url}/handoffs/${h.id}`, { headers: browser() })).json(),
      );
      expect(view.canAnswer).toBe(false);
      expect(view.why).toMatch(/Pair this browser/);

      // Paired with another machine: 403.
      const malloryBrowser = await pair(mallory);
      const aliceBrowser = await pair(alice);
      for (const cookie of [malloryBrowser, aliceBrowser]) {
        expect((await accept(h.id, cookie)).status).toBe(403);
        expect((await decline(h.id, cookie, { note: "no" })).status).toBe(403);
      }
      expect(await status(h.id)).toBe("pending");

      // Paired with bob's machine: accepted, by bob's daemon writing the file.
      const bobBrowser = await pair(bob);
      const mine = HandoffView.parse(
        await (
          await fetch(`${server.url}/handoffs/${h.id}`, { headers: browser(bobBrowser) })
        ).json(),
      );
      expect(mine.canAnswer).toBe(true);
      const res = await accept(h.id, bobBrowser, { folder: "/home/bob/elsewhere" });
      expect(res.status).toBe(200);
      const done = HandoffResponse.parse(await res.json()).handoff;
      expect(done.status).toBe("accepted");
      expect(done.delivery?.path).toBe(`/home/bob/proj/.baton/handoffs/${h.id}.md`);
      expect(bob.of("handoff_write")).toEqual([
        expect.objectContaining({ id: h.id, folder: "/home/bob/elsewhere" }),
      ]);
      // Write instructions go only to the receiving daemon.
      expect(alice.of("handoff_write")).toHaveLength(0);
      expect(mallory.of("handoff_write")).toHaveLength(0);
      expect((await accept(h.id, bobBrowser)).status).toBe(409);
    });

    it("refuses a browser paired with a different machine using the receiver's name", async () => {
      await fakeDaemon("alice", SESSION_A);
      // An impostor named "bob" pairs a browser, then the real bob connects.
      const impostor = await fakeDaemon("bob");
      const stolen = await pair(impostor);
      await impostor.close();
      const bob = await fakeDaemon("bob", SESSION_B);
      const h = await create();
      await until(() => bob.of("handoff_offer").length === 1, "bob's offer");
      expect((await accept(h.id, stolen)).status).toBe(403);
      expect((await decline(h.id, stolen)).status).toBe(403);
      expect(bob.of("handoff_write")).toHaveLength(0);
    });

    it("declines with a note and tells the receiving daemon to forget it", async () => {
      await fakeDaemon("alice", SESSION_A);
      const bob = await fakeDaemon("bob", SESSION_B);
      const h = await create();
      await until(() => bob.of("handoff_offer").length === 1, "bob's offer");
      const cookie = await pair(bob);
      expect((await decline(h.id, cookie, { note: "on holiday" })).status).toBe(200);
      expect(await status(h.id)).toBe("declined");
      await until(
        () => bob.of("handoff_offer").some((o) => o.handoff.status === "declined"),
        "the declined offer",
      );
      expect(bob.of("handoff_write")).toHaveLength(0);
    });

    it("can't accept while the receiving machine is offline", async () => {
      await fakeDaemon("alice", SESSION_A);
      const bob = await fakeDaemon("bob", SESSION_B);
      const h = await create();
      const cookie = await pair(bob);
      await bob.close();
      const res = await accept(h.id, cookie);
      expect(res.status).toBe(409);
      expect(await status(h.id)).toBe("pending");
    });

    it("ignores answers a daemon makes up for handoffs it wasn't asked to write", async () => {
      const alice = await fakeDaemon("alice", SESSION_A);
      const bob = await fakeDaemon("bob", SESSION_B);
      const h = await create();
      for (const d of [alice, bob]) {
        d.ws.send(
          JSON.stringify({
            type: "handoff_written",
            requestId: "made0up",
            id: h.id,
            result: {
              ok: true,
              delivery: { folder: "/x", path: "/x/y", apply: { available: true } },
            },
          }),
        );
        // The retired status message is refused outright.
        d.ws.send(JSON.stringify({ type: "handoff_status", id: h.id, status: "accepted" }));
      }
      await new Promise((r) => setTimeout(r, 200));
      expect(await status(h.id)).toBe("pending");
    });

    it("never sends a daemon anything but offers, write requests and code requests", async () => {
      await fakeDaemon("alice", SESSION_A);
      const bob = await fakeDaemon("bob", SESSION_B);
      const h = await create();
      const cookie = await pair(bob);
      await accept(h.id, cookie);
      for (const path of [`/handoffs/${h.id}/start`, `/handoffs/${h.id}/apply`, "/inbox"]) {
        expect((await fetch(`${server.url}${path}`, json({}, browser(cookie)))).status, path).toBe(
          404,
        );
      }
      const types = new Set(bob.messages.map((m) => m.type));
      for (const t of types) {
        expect(["ingest_hello", "ack", "handoff_offer", "handoff_write"]).toContain(t);
      }
      // And the protocol has no message that runs anything on a daemon.
      const kinds = IngestServerMessage.options.map((o) => o.shape.type.value);
      expect(kinds.sort()).toEqual(
        [
          "ack",
          "error",
          "handoff_code_request",
          "handoff_offer",
          "handoff_write",
          "ingest_hello",
        ].sort(),
      );
    });

    it("resends a pending offer when the receiving daemon reconnects", async () => {
      await fakeDaemon("alice", SESSION_A);
      const bob = await fakeDaemon("bob", SESSION_B);
      await bob.close();
      const h = await create();
      const again = await fakeDaemon("bob");
      await until(() => again.of("handoff_offer").some((o) => o.handoff.id === h.id), "resent");
      expect(await status(h.id)).toBe("pending");
    });
  });

  it("serves the handoff page to a logged-out browser only after login", async () => {
    const page = await fetch(`${server.url}/handoffs/habcdefghij`, {
      headers: { accept: "text/html" },
      redirect: "manual",
    });
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe("/login?next=%2Fhandoffs%2Fhabcdefghij");
  });
});

describe("a handoff's files on disk", () => {
  it("are named by id and git-excluded", async () => {
    const dir = await tempDir("baton-files-");
    await git(dir, "init", "-q");
    await mkdir(join(dir, "src"));
    const inbox = new Inbox({ origin: () => "http://x", logger: silent, notify: undefined });
    const h = Handoff.parse({
      id: "hfilesabcde",
      kind: "note",
      status: "pending",
      sender: "Ada",
      markdown: "# A note",
      from: { sessionId: SESSION_A, agent: "codex", repoId: null, branch: null },
      to: { sessionId: SESSION_B, agent: "codex", repoId: null, branch: null },
      createdAt: "2026-11-03T00:00:00.000Z",
      updatedAt: "2026-11-03T00:00:00.000Z",
    });
    inbox.receive({ type: "handoff_offer", handoff: h });
    const result = await inbox.write(h.id, join(dir, "src"));
    expect(result.ok).toBe(true);
    expect(await readFile(handoffFile(join(dir, "src"), h.id), "utf8")).toContain("# A note");
    expect(await git(dir, "status", "--porcelain")).toBe("");
  });
});
