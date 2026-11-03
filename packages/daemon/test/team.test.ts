import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type BatonEvent, EventsResponse, SessionsResponse } from "@baton/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { resolveServeConfig } from "../src/config.js";
import { DiskQueue } from "../src/disk-queue.js";
import { sharingFilePath, startForwarder } from "../src/forwarder.js";
import { mergeByTime } from "../src/merge.js";
import { ingestUrl, RemoteSink } from "../src/remote-sink.js";
import { writeSharing } from "../src/sharing.js";
import { startTeamServer, type TeamServer } from "../src/team-server.js";
import { record, SESSION_A, SESSION_B, silent, tempProjects } from "./helpers.js";

const TOKEN = "team-token-0123456789";

let seq = 0;
function event(
  sessionId: string,
  text: string,
  ts = new Date(Date.UTC(2026, 10, 1)).toISOString(),
) {
  const n = ++seq;
  return {
    id: `${sessionId}:${n}`,
    agent: "claude-code",
    sessionId,
    projectPath: "/home/dev/proj",
    ts,
    seq: n,
    kind: "reply",
    text,
  } satisfies BatonEvent;
}

async function until(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function serve(port = 0): Promise<TeamServer> {
  const config = resolveServeConfig({
    host: "127.0.0.1",
    port,
    token: TOKEN,
    logLevel: "silent",
    summarizer: "off",
    webDir: join(import.meta.dirname, "no-viewer"),
  });
  return startTeamServer(config, silent);
}

async function allEvents(server: TeamServer, token = TOKEN) {
  const res = await fetch(`${server.url}/events?limit=5000`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return EventsResponse.parse(await res.json()).events;
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

describe("mergeByTime", () => {
  it("keeps each session's order when its timestamps go backwards", () => {
    const a1 = event("a", "a1", "2026-11-01T00:00:05.000Z");
    const a2 = event("a", "a2", "2026-11-01T00:00:01.000Z");
    const b1 = event("b", "b1", "2026-11-01T00:00:03.000Z");
    const merged = mergeByTime([a1, a2, b1]).map((e) => e.text);
    // A global sort by ts would put a2 before a1.
    expect(merged.indexOf("a1")).toBeLessThan(merged.indexOf("a2"));
    expect(merged).toEqual(["b1", "a1", "a2"]);
  });
});

describe("DiskQueue", () => {
  it("survives a restart, resending only what wasn't acknowledged", async () => {
    const dir = join(dirs.root, "q");
    const q = await DiskQueue.open({ dir, maxBytes: 1 << 20, logger: silent });
    await q.push([1, 2, 3].map((i) => ({ backlog: false, event: event("a", `e${i}`) })));
    await q.ack(1);
    await q.close();

    const again = await DiskQueue.open({ dir, maxBytes: 1 << 20, logger: silent });
    expect(again.peek(10, 1 << 20).map((x) => x.event.text)).toEqual(["e2", "e3"]);
  });

  it("drops a torn last line left by a crash", async () => {
    const dir = join(dirs.root, "q");
    const q = await DiskQueue.open({ dir, maxBytes: 1 << 20, logger: silent });
    await q.push([{ backlog: true, event: event("a", "whole") }]);
    await writeFile(
      join(dir, "queue.jsonl"),
      `${await readFile(join(dir, "queue.jsonl"))}{"e":{"id`,
    );
    const again = await DiskQueue.open({ dir, maxBytes: 1 << 20, logger: silent });
    expect(again.peek(10, 1 << 20)).toEqual([{ backlog: true, event: expect.anything() }]);
    expect(again.size).toBe(1);
  });

  it("makes push wait while over its budget, until an ack frees space", async () => {
    const q = await DiskQueue.open({ dir: join(dirs.root, "q"), maxBytes: 300, logger: silent });
    await q.push([{ backlog: false, event: event("a", "x".repeat(150)) }]);
    let done = false;
    const second = q.push([{ backlog: false, event: event("a", "y".repeat(150)) }]).then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(done).toBe(false);
    await q.ack(1);
    await second;
    expect(q.size).toBe(1);
  });

  it("batches only events with the same backlog flag", async () => {
    const q = await DiskQueue.open({
      dir: join(dirs.root, "q"),
      maxBytes: 1 << 20,
      logger: silent,
    });
    await q.push([
      { backlog: true, event: event("a", "old") },
      { backlog: false, event: event("a", "new") },
    ]);
    expect(q.peek(10, 1 << 20).map((x) => x.event.text)).toEqual(["old"]);
  });
});

describe("team server", () => {
  it("rejects viewers and daemons without the token", async () => {
    const server = await serve();
    cleanups.push(() => server.close());
    expect((await fetch(`${server.url}/sessions`)).status).toBe(401);
    expect(
      (
        await fetch(`${server.url}/sessions`, {
          headers: { authorization: "Bearer wrong-token!!" },
        })
      ).status,
    ).toBe(401);
    const page = await fetch(`${server.url}/`, { redirect: "manual" });
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe("/login");
    expect((await fetch(`${server.url}/health`)).status).toBe(200);

    const status = await new Promise<number>((resolve) => {
      const ws = new WebSocket(ingestUrl(server.url, "eve"));
      ws.on("unexpected-response", (req, res) => {
        req.destroy();
        resolve(res.statusCode ?? 0);
      });
      ws.on("open", () => {
        ws.close();
        resolve(101);
      });
    });
    expect(status).toBe(401);
  });

  it("signs a browser in with a cookie", async () => {
    const server = await serve();
    cleanups.push(() => server.close());
    const bad = await fetch(`${server.url}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "nope" }),
    });
    expect(bad.status).toBe(401);
    const good = await fetch(`${server.url}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN }),
    });
    const cookie = good.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect(cookie).toMatch(/^baton_session=/);
    expect(cookie).not.toContain(TOKEN);
    const res = await fetch(`${server.url}/sessions`, { headers: { cookie } });
    expect(res.status).toBe(200);
  });

  it("refuses a cross-origin request even with the cookie", async () => {
    const server = await serve();
    cleanups.push(() => server.close());
    const res = await fetch(`${server.url}/sessions`, {
      headers: { authorization: `Bearer ${TOKEN}`, origin: "http://evil.example" },
    });
    expect(res.status).toBe(403);
  });

  it("stores events from a RemoteSink once each, grouped by daemon name", async () => {
    const server = await serve();
    cleanups.push(() => server.close());
    const queue = await DiskQueue.open({
      dir: join(dirs.root, "q"),
      maxBytes: 1 << 20,
      logger: silent,
    });
    const sink = new RemoteSink({
      server: server.url,
      token: TOKEN,
      name: "alice",
      queue,
      logger: silent,
    });
    cleanups.push(() => sink.close());
    sink.start();

    const batch = [event(SESSION_A, "one"), event(SESSION_A, "two")];
    await sink.publish(batch);
    await sink.publish(batch); // a resend after a crash: same ids
    await sink.publish([event(SESSION_B, "three")], { backlog: true });
    await sink.drained();

    const events = await allEvents(server);
    expect(events.map((m) => m.event.text)).toEqual(["one", "two", "three"]);
    expect(events.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(events[2]?.backlog).toBe(true);

    const res = await fetch(`${server.url}/sessions`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const { sessions } = SessionsResponse.parse(await res.json());
    expect(sessions.map((s) => s.source)).toEqual(["alice", "alice"]);
  });

  it("queues while the server is down and delivers after it comes back", async () => {
    const first = await serve();
    const port = first.port;
    await first.close();

    const queue = await DiskQueue.open({
      dir: join(dirs.root, "q"),
      maxBytes: 1 << 20,
      logger: silent,
    });
    const sink = new RemoteSink({
      server: `ws://127.0.0.1:${port}`,
      token: TOKEN,
      name: "bob",
      queue,
      logger: silent,
      minRetryMs: 20,
      maxRetryMs: 100,
    });
    cleanups.push(() => sink.close());
    sink.start();
    await sink.publish([event(SESSION_A, "while down")]);
    await new Promise((r) => setTimeout(r, 150));
    expect(sink.pending).toBe(1);

    const server = await serve(port);
    cleanups.push(() => server.close());
    await sink.drained();
    expect((await allEvents(server)).map((m) => m.event.text)).toEqual(["while down"]);
  });

  it("gets a watched transcript to the server through a forwarder, across a restart", async () => {
    const server = await serve();
    cleanups.push(() => server.close());
    const config = {
      port: 0,
      projectsDir: dirs.projectsDir,
      codexDir: dirs.codexDir,
      stateFile: dirs.stateFile,
      backlog: "all" as const,
      bufferMb: 1,
      activeMinutes: 120,
      recent: 0,
      poll: false,
      logLevel: "silent" as const,
      summarizer: "off" as const,
      summarizerModel: "m",
      ollamaUrl: "http://127.0.0.1:11434",
      webDir: dirs.root,
    };
    const remote = {
      server: server.url,
      token: TOKEN,
      name: "carol",
      queueDir: join(dirs.root, "queue"),
      queueMb: 1,
    };
    const file = dirs.transcript(SESSION_A);
    // Only /home/dev/proj is shared; SESSION_B, in another folder, must never arrive.
    await writeSharing(sharingFilePath(dirs.stateFile), {
      paused: false,
      repos: [],
      folders: ["/home/dev/proj"],
    });
    const key = `gh${"p_"}${"k".repeat(36)}`;
    await dirs.append(file, `${record(SESSION_A, "user", `hello, my key is ${key}`)}\n`);
    await dirs.append(
      dirs.transcript(SESSION_B),
      `${record(SESSION_B, "user", "private work", "/home/dev/private")}\n`,
    );

    const first = await startForwarder(config, remote, silent);
    await until(async () => (await allEvents(server)).length >= 2, "first events");
    await first.close();

    await dirs.append(file, `${record(SESSION_A, "assistant", "hi there")}\n`);
    const second = await startForwarder(config, remote, silent);
    cleanups.push(() => second.close());
    await until(
      async () => (await allEvents(server)).some((m) => m.event.text === "hi there"),
      "the reply",
    );
    const events = await allEvents(server);
    const ids = events.map((m) => m.event.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(events.map((m) => m.event.text)).toContain("hello, my key is [redacted]");
    expect(events.some((m) => m.event.sessionId === SESSION_B)).toBe(false);
    expect(JSON.stringify(events)).not.toContain(key);
  });
});
