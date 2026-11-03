import {
  BATON_VERSION,
  type BatonEvent,
  type HandoffOfferMessage,
  type HandoffStatusMessage,
  INGEST_PROTOCOL_VERSION,
  IngestServerMessage,
  type PublishMessage,
  type RepoInfo,
} from "@baton/core";
import type { Logger } from "pino";
import WebSocket from "ws";
import type { DiskQueue } from "./disk-queue.js";
import { newMachineId } from "./machine-id.js";
import type { EventSink, PublishOptions } from "./sink.js";

export type RemoteSinkOptions = {
  /** Team server base URL, `ws://host:port` or `wss://…` (`http(s)://` also works). */
  server: string;
  /** Team token, sent as a bearer token. */
  token: string;
  /** Display name teammates see for this daemon's sessions. */
  name: string;
  queue: DiskQueue;
  logger: Logger;
  /** Most events per batch. Default 500. */
  batchEvents?: number;
  /** Rough byte budget per batch. Default 1 MB. */
  batchBytes?: number;
  /** Reconnect backoff bounds. Defaults 250 ms and 10 s. */
  minRetryMs?: number;
  maxRetryMs?: number;
  /** Ping interval; a connection silent for two of these is dropped. Default 10 s. */
  pingMs?: number;
  /** A batch not acked within this is assumed lost and the connection is dropped. Default 30 s. */
  ackTimeoutMs?: number;
  /** Handoff messages from the server, for this machine's inbox. */
  onHandoff?: (message: HandoffOfferMessage) => void;
  /** This machine's id (see `loadMachineId`). Default: a new one per sink. */
  machine?: string;
  /**
   * The server refused this daemon for good (wrong version, name taken).
   * The sink has stopped reconnecting; the message says what to do.
   */
  onRefused?: (message: string) => void;
};

/** Answers about handoffs, sent up the same connection. */
export type HandoffControl = HandoffStatusMessage;

type InFlight = { batch: number; count: number; timer: NodeJS.Timeout };

/** The `/ingest` WebSocket URL for a server base URL, daemon name and machine id. */
export function ingestUrl(server: string, name: string, machine: string = newMachineId()): string {
  const url = new URL(server);
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/ingest`;
  url.search = new URLSearchParams({
    name,
    protocol: String(INGEST_PROTOCOL_VERSION),
    app: BATON_VERSION,
    machine,
  }).toString();
  return url.toString();
}

/**
 * Sends events to a team server instead of a local hub.
 *
 * `publish` resolves once events are in the on-disk queue; a background loop
 * keeps one batch in flight, removing it from the queue when the server acks
 * it. A dropped connection is retried with backoff and the unacked batch is
 * sent again, so delivery is at-least-once in publish order; the server makes
 * it exactly-once by skipping event ids it already holds.
 */
export class RemoteSink implements EventSink {
  readonly #url: string;
  readonly #log: Logger;
  #socket: WebSocket | undefined;
  #open = false;
  #inFlight: InFlight | undefined;
  #nextBatch = 0;
  /** Latest git identity per project directory, sent with batches that mention it. */
  readonly #repos = new Map<string, RepoInfo>();
  #retryMs: number;
  #retryTimer: NodeJS.Timeout | undefined;
  #pingTimer: NodeJS.Timeout | undefined;
  #alive = false;
  #closed = false;
  #connectedOnce = false;
  /** The server's `ingest_hello` on this connection, if it sent one. */
  #server: { app: string; protocol: number } | undefined;
  #warnedNoHello = false;
  /** Refused for good: stop reconnecting. */
  #refused: string | undefined;
  #drainWaiters: (() => void)[] = [];
  /** Handoff answers waiting for a connection; the server resends offers on connect anyway. */
  #control: HandoffControl[] = [];

  constructor(readonly options: RemoteSinkOptions) {
    this.#url = ingestUrl(options.server, options.name, options.machine);
    this.#log = options.logger.child({ server: new URL(this.#url).host, name: options.name });
    this.#retryMs = this.#minRetry;
  }

  get #minRetry(): number {
    return this.options.minRetryMs ?? 250;
  }

  /** What the server said it runs, once connected. */
  get serverVersion(): { app: string; protocol: number } | undefined {
    return this.#server;
  }

  /** Why the server refused this daemon for good, if it did. */
  get refused(): string | undefined {
    return this.#refused;
  }

  /** Whether the connection to the server is currently open. */
  get connected(): boolean {
    return this.#open;
  }

  /** Events not yet acknowledged by the server. */
  get pending(): number {
    return this.options.queue.size;
  }

  async publish(events: readonly BatonEvent[], options: PublishOptions = {}): Promise<void> {
    const backlog = options.backlog === true;
    for (const [dir, info] of Object.entries(options.repos ?? {})) this.#repos.set(dir, info);
    await this.options.queue.push(events.map((event) => ({ backlog, event })));
    this.#pump();
  }

  /** Sends a handoff answer now, or once connected. */
  sendControl(message: HandoffControl): void {
    this.#control.push(message);
    this.#flushControl();
  }

  #flushControl(): void {
    const socket = this.#socket;
    if (!this.#open || !socket) return;
    for (const message of this.#control.splice(0)) socket.send(JSON.stringify(message));
  }

  /** Starts connecting; returns immediately (events queue until the server is reachable). */
  start(): void {
    this.#connect();
  }

  /** Resolves once every queued event has been acknowledged. */
  drained(): Promise<void> {
    if (this.options.queue.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.#drainWaiters.push(resolve));
  }

  /** Disconnects. Unsent events stay in the queue for the next run. */
  async close(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#retryTimer);
    this.#stopPing();
    if (this.#inFlight) clearTimeout(this.#inFlight.timer);
    this.#inFlight = undefined;
    const socket = this.#socket;
    this.#socket = undefined;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
        socket.close(1001, "daemon stopping");
        setTimeout(() => {
          socket.terminate();
          resolve();
        }, 1000).unref();
      });
    }
    await this.options.queue.close();
  }

  #connect(): void {
    if (this.#closed || this.#refused !== undefined) return;
    const socket = new WebSocket(this.#url, {
      headers: { authorization: `Bearer ${this.options.token}` },
      handshakeTimeout: 10_000,
    });
    this.#socket = socket;

    socket.on("open", () => {
      if (socket !== this.#socket) return;
      this.#open = true;
      this.#server = undefined;
      this.#log.info(
        { pending: this.options.queue.size },
        this.#connectedOnce ? "reconnected to team server" : "connected to team server",
      );
      this.#connectedOnce = true;
      this.#startPing(socket);
      this.#flushControl();
      this.#pump();
    });
    socket.on("message", (data, isBinary) => {
      if (socket !== this.#socket || isBinary) return;
      this.#alive = true;
      this.#receive(data.toString());
    });
    socket.on("pong", () => {
      this.#alive = true;
    });
    socket.on("unexpected-response", (_req, res) => {
      const level = res.statusCode === 401 || res.statusCode === 403 ? "error" : "warn";
      this.#log[level]({ status: res.statusCode }, "team server refused the connection");
      socket.terminate();
    });
    socket.on("error", (err) => {
      if (socket === this.#socket)
        this.#log.debug({ err: err.message }, "team server socket error");
    });
    socket.on("close", () => {
      if (socket !== this.#socket) return;
      this.#onDisconnect();
    });
  }

  #onDisconnect(): void {
    const wasOpen = this.#open;
    this.#open = false;
    this.#socket = undefined;
    this.#stopPing();
    if (this.#inFlight) clearTimeout(this.#inFlight.timer);
    this.#inFlight = undefined;
    if (this.#closed || this.#refused !== undefined) return;
    if (wasOpen)
      this.#log.warn({ pending: this.options.queue.size }, "lost team server connection");
    const delay = Math.round(this.#retryMs * (0.75 + Math.random() * 0.5));
    this.#retryMs = Math.min(this.#retryMs * 2, this.options.maxRetryMs ?? 10_000);
    this.#retryTimer = setTimeout(() => this.#connect(), delay);
  }

  #receive(text: string): void {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    const msg = IngestServerMessage.safeParse(json);
    if (!msg.success) {
      this.#log.warn("team server sent an invalid message");
      return;
    }
    if (msg.data.type === "error") {
      if (msg.data.code === "version" || msg.data.code === "name_taken") {
        this.#refuse(msg.data.message);
        return;
      }
      this.#log.error({ message: msg.data.message }, "team server reported an error");
      return;
    }
    if (msg.data.type === "ingest_hello") {
      this.#server = { app: msg.data.app, protocol: msg.data.protocol };
      if (msg.data.protocol !== INGEST_PROTOCOL_VERSION) {
        this.#refuse(
          `The team server speaks protocol ${msg.data.protocol} (Baton ${msg.data.app}); this daemon speaks ${INGEST_PROTOCOL_VERSION} (Baton ${BATON_VERSION}). Update whichever is older.`,
        );
      }
      return;
    }
    if (this.#server === undefined && !this.#warnedNoHello) {
      this.#warnedNoHello = true;
      this.#log.warn(
        "the team server didn't say which version it runs; it's probably older than this daemon. Ask whoever runs it to update.",
      );
    }
    if (msg.data.type === "handoff_offer") {
      this.options.onHandoff?.(msg.data);
      return;
    }
    const inFlight = this.#inFlight;
    if (!inFlight || msg.data.batch !== inFlight.batch) return; // stale ack from a resend
    clearTimeout(inFlight.timer);
    this.#retryMs = this.#minRetry;
    this.options.queue.ack(inFlight.count).then(
      () => {
        if (this.#inFlight === inFlight) this.#inFlight = undefined;
        if (this.options.queue.size === 0) this.#notifyDrained();
        this.#pump();
      },
      (err: unknown) => {
        this.#log.error({ err }, "could not record an ack; the batch will be sent again");
        if (this.#inFlight === inFlight) this.#inFlight = undefined;
        this.#pump();
      },
    );
  }

  /** Sends the next batch if connected and nothing is in flight. */
  #pump(): void {
    const socket = this.#socket;
    if (!this.#open || !socket || this.#inFlight || this.#closed) return;
    const items = this.options.queue.peek(
      this.options.batchEvents ?? 500,
      this.options.batchBytes ?? 1024 * 1024,
    );
    const first = items[0];
    if (!first) return;
    const batch = this.#nextBatch++;
    const events = items.map((i) => i.event);
    const repos: Record<string, RepoInfo> = {};
    for (const e of events) {
      const info = this.#repos.get(e.projectPath);
      if (info) repos[e.projectPath] = info;
    }
    const msg: PublishMessage = {
      type: "publish",
      batch,
      ...(first.backlog ? { backlog: true } : {}),
      events,
      ...(Object.keys(repos).length > 0 ? { repos } : {}),
    };
    const timer = setTimeout(() => {
      this.#log.warn({ batch }, "no ack from team server; reconnecting");
      socket.terminate();
    }, this.options.ackTimeoutMs ?? 30_000);
    this.#inFlight = { batch, count: items.length, timer };
    socket.send(JSON.stringify(msg));
  }

  /** Stops for good: logs why, tells the owner, and closes the socket without retrying. */
  #refuse(message: string): void {
    if (this.#refused !== undefined) return;
    this.#refused = message;
    this.#log.error(message);
    clearTimeout(this.#retryTimer);
    this.#socket?.close(1000, "refused");
    this.options.onRefused?.(message);
  }

  #startPing(socket: WebSocket): void {
    this.#alive = true;
    this.#pingTimer = setInterval(() => {
      if (!this.#alive) {
        this.#log.warn("team server stopped answering pings; reconnecting");
        socket.terminate();
        return;
      }
      this.#alive = false;
      socket.ping();
    }, this.options.pingMs ?? 10_000);
  }

  #stopPing(): void {
    clearInterval(this.#pingTimer);
    this.#pingTimer = undefined;
  }

  #notifyDrained(): void {
    const waiters = this.#drainWaiters;
    this.#drainWaiters = [];
    for (const wake of waiters) wake();
  }
}
