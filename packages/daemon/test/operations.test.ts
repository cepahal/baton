import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BATON_VERSION,
  type BatonEvent,
  EventsResponse,
  INGEST_PROTOCOL_VERSION,
  ServerMessage,
  SessionsResponse,
} from "@baton/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { snapshot, snapshots, startBackups } from "../src/backup.js";
import { resolveServeConfig } from "../src/config.js";
import { type DoctorDeps, formatChecks, runDoctor } from "../src/doctor.js";
import { MemoryEventLog } from "../src/event-log.js";
import { buildReport, redactLine } from "../src/report.js";
import { startTeamServer, type TeamServer } from "../src/team-server.js";
import { silent } from "./helpers.js";

const TOKEN = "operations-token-0123456789";

let dir: string;
const cleanups: (() => Promise<unknown>)[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "baton-ops-"));
});
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  await rm(dir, { recursive: true, force: true });
});

let n = 0;
const event = (sessionId: string, text = "hi"): BatonEvent => ({
  id: `e${++n}`,
  agent: "claude-code",
  sessionId,
  projectPath: "/work/app",
  ts: new Date(Date.UTC(2026, 10, 3, 10, 0, 0, n)).toISOString(),
  seq: n,
  kind: "prompt",
  text,
});

async function serve(removedFile?: string): Promise<TeamServer> {
  const server = await startTeamServer(
    resolveServeConfig({
      host: "127.0.0.1",
      port: 0,
      token: TOKEN,
      logLevel: "silent",
      summarizer: "off",
      webDir: join(import.meta.dirname, "no-viewer"),
    }),
    silent,
    removedFile === undefined ? {} : { removedFile },
  );
  cleanups.push(() => server.close());
  return server;
}

const auth = { authorization: `Bearer ${TOKEN}` };

describe("removing a session", () => {
  it("drops its events for everyone, tells viewers, and ignores later resends", async () => {
    const removedFile = join(dir, "team-removed.json");
    const server = await serve(removedFile);
    server.hub.accept([event("keep"), event("gone", "oops, pasted a secret"), event("keep")]);

    const ws = new WebSocket(`${server.url.replace("http", "ws")}/ws`, { headers: auth });
    cleanups.push(async () => ws.terminate());
    const got: ServerMessage[] = [];
    ws.on("message", (d) => got.push(ServerMessage.parse(JSON.parse(String(d)))));
    await expect.poll(() => got.filter((m) => m.type === "event").length).toBe(3);

    expect(
      (await fetch(`${server.url}/sessions/gone`, { method: "DELETE" })).status,
      "needs the token",
    ).toBe(401);
    const res = await fetch(`${server.url}/sessions/gone`, { method: "DELETE", headers: auth });
    expect(res.status).toBe(204);
    await expect.poll(() => got.some((m) => m.type === "session_removed")).toBe(true);
    expect(got.find((m) => m.type === "session_removed")).toEqual({
      type: "session_removed",
      sessionId: "gone",
    });

    const events = EventsResponse.parse(
      await (await fetch(`${server.url}/events`, { headers: auth })).json(),
    ).events;
    expect(events.map((e) => e.event.sessionId)).toEqual(["keep", "keep"]);
    const sessions = SessionsResponse.parse(
      await (await fetch(`${server.url}/sessions`, { headers: auth })).json(),
    ).sessions;
    expect(sessions.map((s) => s.sessionId)).toEqual(["keep"]);

    // The daemon resends its backlog (e.g. after a restart): it stays gone.
    expect(server.hub.accept([event("gone", "resent")])).toBe(0);
    expect(
      (await fetch(`${server.url}/sessions/nope`, { method: "DELETE", headers: auth })).status,
    ).toBe(404);

    // ...even across a server restart.
    await server.close();
    cleanups.pop();
    const again = await serve(removedFile);
    expect(again.hub.accept([event("gone", "resent later")])).toBe(0);
  });

  it("keeps seqs and paging intact around the removed events", () => {
    const log = new MemoryEventLog({ maxBytes: 1 << 20 });
    for (const s of ["a", "b", "a", "b", "a"]) log.append(event(s), false);
    expect(log.forgetSession("b")).toBe(2);
    expect(log.read(0, 2).map((e) => e.seq)).toEqual([1, 3]);
    expect(log.read(3, 10).map((e) => e.seq)).toEqual([5]);
    expect(log.lastSeq).toBe(5);
    // A forgotten event's id is free again (the hub refuses it separately).
    expect(log.append({ ...event("b"), id: "e-new" }, false)?.seq).toBe(6);
  });
});

describe("a session's repo", () => {
  it("stays its last known repo when its latest folder has none", async () => {
    const server = await serve();
    const repo = { repoId: "github.com/acme/shop", branch: "main", relativeCwd: "" };
    server.hub.accept([{ ...event("s1"), projectPath: "/work/shop" }], {
      repos: { "/work/shop": repo },
    });
    // Later events from a folder git can't place (another spelling, a removed worktree).
    server.hub.accept([{ ...event("s1"), projectPath: "C:\\Users\\dev\\shop" }]);
    expect(server.hub.sessions()[0]?.repo).toEqual(repo);
  });
});

describe("backups", () => {
  it("snapshots state files and note files, keeps the newest few, and prunes unused files", async () => {
    const state = join(dir, "state");
    const blobs = join(state, "team-blobs");
    await mkdir(blobs, { recursive: true });
    const notes = join(state, "team-notes.json");
    await writeFile(notes, '{"version":1,"data":[]}');
    const blobA = "a".repeat(64);
    await writeFile(join(blobs, blobA), "file a");
    const backupDir = join(dir, "backups");
    let t = Date.UTC(2026, 10, 1);
    const opts = {
      files: [notes, join(state, "missing.json")],
      blobsDir: blobs,
      backupDir,
      keep: 2,
      now: () => new Date(t),
    };

    const first = await snapshot(opts);
    expect(await readFile(join(first, "team-notes.json"), "utf8")).toBe('{"version":1,"data":[]}');
    expect(await readFile(join(backupDir, "blobs", blobA), "utf8")).toBe("file a");

    // The file goes away from the live store; two more snapshots push the first one out.
    await rm(join(blobs, blobA));
    t += 86_400_000;
    await snapshot(opts);
    t += 86_400_000;
    await snapshot(opts);
    expect(await snapshots(backupDir)).toHaveLength(2);
    expect(await readdir(join(backupDir, "blobs"))).toEqual([]);
  });

  it("takes one at start only when the newest is older than a day", async () => {
    const backupDir = join(dir, "backups");
    const blobsDir = join(dir, "blobs");
    let t = Date.UTC(2026, 10, 1, 12);
    const opts = { files: [], blobsDir, backupDir, now: () => new Date(t) };
    const first = startBackups(opts);
    await first.ready;
    first.stop();
    t += 60 * 60_000; // an hour later: a restart doesn't snapshot again
    const second = startBackups(opts);
    await second.ready;
    second.stop();
    expect(await snapshots(backupDir)).toHaveLength(1);
    t += 24 * 60 * 60_000;
    const third = startBackups(opts);
    await third.ready;
    third.stop();
    expect(await snapshots(backupDir)).toHaveLength(2);
  });
});

describe("issue report", () => {
  it("bundles the version and the last 200 log lines, redacted", async () => {
    const home = "C:\\Users\\alice";
    const logFile = join(dir, "daemon.log");
    const lines = Array.from({ length: 250 }, (_, i) => JSON.stringify({ msg: `line ${i}` }));
    lines.push(JSON.stringify({ msg: "token team-secret-token-xyz in C:\\Users\\alice\\code" }));
    lines.push(`{"msg":"API_KEY=abcdefgh12345678"}`);
    await writeFile(logFile, `${lines.join("\n")}\n`);
    const report = await buildReport({ logFile, secrets: ["team-secret-token-xyz"], home });
    expect(report).toContain(`- baton: ${BATON_VERSION}`);
    expect(report).toContain(`- protocol: ${INGEST_PROTOCOL_VERSION}`);
    expect(report).toContain("## Last 200 log lines (redacted)");
    expect(report).not.toContain('"line 51"');
    expect(report).toContain('"line 52"');
    expect(report).not.toContain("team-secret-token-xyz");
    expect(report).not.toContain("alice");
    expect(report).toContain("API_KEY=[redacted]");
  });

  it("redacts JSON-escaped home paths too", () => {
    expect(redactLine('{"dir":"C:\\\\Users\\\\bob\\\\x"}', [], "C:\\Users\\bob")).toBe(
      '{"dir":"~\\\\x"}',
    );
    expect(redactLine("/home/bob/x", [], "/home/bob")).toBe("~/x");
  });

  it("is fine without a log file", async () => {
    expect(await buildReport({ logFile: join(dir, "none.log") })).toContain("## Last 0 log lines");
  });
});

describe("baton doctor", () => {
  const input = {
    nodeVersion: "v20.19.1",
    projectsDir: "/home/a/.claude/projects",
    codexDir: "/home/a/.codex/sessions",
    sharingFile: "",
    logFile: "/state/logs/daemon.log",
  };
  const deps = (overrides: Partial<DoctorDeps> = {}): DoctorDeps => ({
    fetch: async () => new Response("{}", { status: 404 }),
    gitVersion: async () => "git version 2.47.0",
    isDir: async (p) => p.includes(".claude"),
    now: () => Date.parse("2026-11-03T10:00:00.000Z"),
    ...overrides,
  });

  it("passes a good setup, including the server, token, version and clock", async () => {
    const sharingFile = join(dir, "sharing.json");
    await writeFile(
      sharingFile,
      JSON.stringify({ version: 1, data: { repos: ["github.com/a/b"] } }),
    );
    const fetchImpl: typeof fetch = async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/health") return Response.json({ ok: true, epoch: "e", seq: 0 });
      return Response.json({
        ok: true,
        app: BATON_VERSION,
        protocol: INGEST_PROTOCOL_VERSION,
        now: "2026-11-03T10:00:30.000Z",
      });
    };
    const checks = await runDoctor(
      { ...input, sharingFile, server: "ws://team:7777", token: "t" },
      deps({ fetch: fetchImpl }),
    );
    expect(checks.filter((c) => c.status !== "ok")).toEqual([]);
    expect(formatChecks(checks)).toMatch(/All good\.\n$/);
  });

  it("explains each problem with a fix", async () => {
    const fetchImpl: typeof fetch = async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/health") return Response.json({ ok: true });
      return Response.json({
        ok: true,
        app: "9.0.0",
        protocol: INGEST_PROTOCOL_VERSION + 1,
        now: "2026-11-03T10:10:00.000Z",
      });
    };
    const checks = await runDoctor(
      {
        ...input,
        nodeVersion: "v18.20.0",
        sharingFile: join(dir, "none.json"),
        server: "ws://team:7777",
        token: "t",
      },
      deps({ fetch: fetchImpl, gitVersion: async () => undefined, isDir: async () => false }),
    );
    const text = formatChecks(checks);
    expect(text).toContain("✗ Node v18.20.0 is too old");
    expect(text).toContain("✗ git isn't on PATH");
    expect(text).toContain("! no agent logs found");
    expect(text).toContain("! no repos are shared yet");
    expect(text).toMatch(/✗ team server runs Baton 9\.0\.0.*\n\s+→ update Baton on this machine/);
    expect(text).toMatch(/! clock is 600 s behind the server/);
  });

  it("reports an unreachable server and a wrong token", async () => {
    const down = await runDoctor(
      { ...input, server: "ws://team:7777", token: "t" },
      deps({ fetch: async () => Promise.reject(new Error("ECONNREFUSED")) }),
    );
    expect(formatChecks(down)).toMatch(
      /✗ can't reach the team server.*ECONNREFUSED[\s\S]*Tailscale/,
    );
    const wrong = await runDoctor(
      { ...input, server: "ws://team:7777", token: "t" },
      deps({
        fetch: async (url) =>
          new URL(String(url)).pathname === "/health"
            ? Response.json({ ok: true })
            : new Response("", { status: 401 }),
      }),
    );
    expect(formatChecks(wrong)).toContain("✗ the team server rejected BATON_TOKEN");
  });

  it("checks a real team server end to end", async () => {
    const server = await serve();
    const checks = await runDoctor({ ...input, server: server.url, token: TOKEN });
    expect(checks.find((c) => c.what.startsWith("team server runs"))?.status).toBe("ok");
    expect(checks.find((c) => c.what === "team token accepted")?.status).toBe("ok");
  });
});
