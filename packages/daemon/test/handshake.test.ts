import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BATON_VERSION,
  INGEST_PROTOCOL_VERSION,
  IngestServerMessage,
  WhoamiResponse,
} from "@baton/core";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { resolveServeConfig } from "../src/config.js";
import { DiskQueue } from "../src/disk-queue.js";
import { newMachineId } from "../src/machine-id.js";
import { RemoteSink } from "../src/remote-sink.js";
import { versionRefusal } from "../src/server.js";
import { startTeamServer, type TeamServer } from "../src/team-server.js";
import { silent } from "./helpers.js";

const TOKEN = "handshake-token-0123456789";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function serve(): Promise<TeamServer> {
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
  );
  cleanups.push(() => server.close());
  return server;
}

/** Opens `/ingest` with a hand-made query; collects messages and the close code. */
function connect(server: TeamServer, query: Record<string, string>) {
  const url = new URL("/ingest", server.url.replace("http", "ws"));
  url.search = new URLSearchParams(query).toString();
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${TOKEN}` } });
  const messages: IngestServerMessage[] = [];
  ws.on("message", (d) => messages.push(IngestServerMessage.parse(JSON.parse(String(d)))));
  const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
  cleanups.push(async () => ws.terminate());
  return { ws, messages, closed };
}

const current = (name: string, machine = newMachineId()) => ({
  name,
  protocol: String(INGEST_PROTOCOL_VERSION),
  app: BATON_VERSION,
  machine,
});

describe("version handshake", () => {
  it("tells a daemon from before versioning to update, and closes", async () => {
    const server = await serve();
    const c = connect(server, { name: "old-alice" });
    expect(await c.closed).toBe(1008);
    expect(c.messages).toEqual([
      expect.objectContaining({
        type: "error",
        code: "version",
        message: expect.stringMatching(/Please update Baton/),
      }),
    ]);
  });

  it("tells a newer daemon that the server is the one to update", () => {
    expect(versionRefusal(INGEST_PROTOCOL_VERSION + 1, "9.9.9")).toMatch(
      /Ask whoever runs the team server to update/,
    );
    expect(versionRefusal(INGEST_PROTOCOL_VERSION, BATON_VERSION)).toBeUndefined();
  });

  it("greets a current daemon with the server's version", async () => {
    const server = await serve();
    const c = connect(server, current("alice"));
    await expect
      .poll(() => c.messages[0])
      .toEqual({
        type: "ingest_hello",
        protocol: INGEST_PROTOCOL_VERSION,
        app: BATON_VERSION,
      });
  });

  it("refuses a second machine using a connected name, but lets the same machine reconnect", async () => {
    const server = await serve();
    const machine = newMachineId();
    const first = connect(server, current("grant", machine));
    await expect.poll(() => first.messages.length).toBe(1);

    const other = connect(server, current("grant"));
    expect(await other.closed).toBe(1008);
    expect(other.messages[0]).toMatchObject({ type: "error", code: "name_taken" });

    const again = connect(server, current("grant", machine));
    await expect.poll(() => again.messages[0]?.type).toBe("ingest_hello");
  });

  it("stops a RemoteSink for good when it's refused, and says why", async () => {
    const server = await serve();
    const holder = connect(server, current("dup"));
    await expect.poll(() => holder.messages.length).toBe(1);

    const dir = await mkdtemp(join(tmpdir(), "baton-handshake-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const queue = await DiskQueue.open({ dir, maxBytes: 1 << 20, logger: silent });
    const refusals: string[] = [];
    const sink = new RemoteSink({
      server: server.url,
      token: TOKEN,
      name: "dup",
      queue,
      logger: silent,
      minRetryMs: 10,
      onRefused: (m) => refusals.push(m),
    });
    cleanups.push(() => sink.close());
    sink.start();
    await expect.poll(() => refusals.length).toBe(1);
    expect(refusals[0]).toMatch(/already connected as "dup"/);
    expect(sink.refused).toBe(refusals[0]);
    // No reconnects follow: still one refusal, and not connected, a while later.
    await new Promise((r) => setTimeout(r, 200));
    expect(refusals).toHaveLength(1);
    expect(sink.connected).toBe(false);
  });
});

describe("/whoami", () => {
  it("needs the token and reports the server's version and clock", async () => {
    const server = await serve();
    expect((await fetch(`${server.url}/whoami`)).status).toBe(401);
    const res = await fetch(`${server.url}/whoami`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body = WhoamiResponse.parse(await res.json());
    expect(body).toMatchObject({ ok: true, app: BATON_VERSION, protocol: INGEST_PROTOCOL_VERSION });
    expect(Math.abs(Date.parse(body.now) - Date.now())).toBeLessThan(5000);
  });
});
