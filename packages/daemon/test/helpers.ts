import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EventMessage, ServerMessage } from "@baton/core";
import { pino } from "pino";
import WebSocket from "ws";
import { resolveConfig } from "../src/config.js";
import { type Daemon, startDaemon } from "../src/daemon.js";

export const silent = pino({ level: "silent" });

export const SESSION_A = "00000000-0000-4000-8000-00000000000a";
export const SESSION_B = "00000000-0000-4000-8000-00000000000b";

let n = 0;
/** One transcript line: a user prompt or an assistant reply. */
export function record(session: string, kind: "user" | "assistant", text: string): string {
  const message =
    kind === "user"
      ? { role: "user", content: text }
      : { role: "assistant", model: "claude-x", content: [{ type: "text", text }] };
  return JSON.stringify({
    type: kind,
    uuid: `r${++n}`,
    sessionId: session,
    timestamp: new Date(Date.UTC(2026, 10, 1, 12, 0, 0, n)).toISOString(),
    cwd: "/home/dev/proj",
    message,
  });
}

/**
 * A temp projects dir with one project folder, plus a Codex sessions dir that
 * doesn't exist yet (so tests never read the real `~/.codex`). Removed by `cleanup`.
 */
export async function tempProjects() {
  const root = await mkdtemp(join(tmpdir(), "baton-daemon-"));
  const projectsDir = join(root, "projects");
  const project = join(projectsDir, "-home-dev-proj");
  await mkdir(project, { recursive: true });
  return {
    root,
    projectsDir,
    codexDir: join(root, "codex"),
    stateFile: join(root, "state.json"),
    transcript: (session: string) => join(project, `${session}.jsonl`),
    append: (file: string, data: string) => appendFile(file, data),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

export function start(
  dirs: { projectsDir: string; codexDir: string; stateFile: string },
  overrides: Parameters<typeof resolveConfig>[0] = {},
): Promise<Daemon> {
  const config = resolveConfig({ port: 0, logLevel: "silent", ...dirs, ...overrides });
  return startDaemon(config, silent);
}

/** A WebSocket client that records every server message. */
export class TestClient {
  readonly messages: ServerMessage[] = [];
  readonly ws: WebSocket;
  readonly opened: Promise<void>;
  #waiters: (() => void)[] = [];

  constructor(url: string, headers: Record<string, string> = {}) {
    this.ws = new WebSocket(url, { headers });
    this.opened = new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
      this.ws.once("unexpected-response", (req, res) => {
        // With this listener attached, ws leaves aborting the request to us.
        req.destroy();
        reject(new Error(`HTTP ${res.statusCode}`));
      });
    });
    this.ws.on("message", (data) => {
      this.messages.push(ServerMessage.parse(JSON.parse(data.toString())));
      for (const w of this.#waiters.splice(0)) w();
    });
  }

  get events(): EventMessage[] {
    return this.messages.filter((m): m is EventMessage => m.type === "event");
  }

  /** Event texts in arrival order. */
  get texts(): string[] {
    return this.events.map((m) => m.event.text);
  }

  /** Waits until `predicate` holds, failing after `timeoutMs`. */
  async until(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      const left = deadline - Date.now();
      if (left <= 0)
        throw new Error(`timed out waiting for ${what}; got ${JSON.stringify(this.texts)}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(left, 100));
        this.#waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  untilEvents(count: number): Promise<void> {
    return this.until(() => this.events.length >= count, `${count} events`);
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws.readyState !== WebSocket.OPEN) {
        this.ws.terminate();
        return resolve();
      }
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }
}

export const wsUrl = (daemon: Daemon, query = "") =>
  `${daemon.url.replace("http", "ws")}/ws${query ? `?${query}` : ""}`;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
