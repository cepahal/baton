import {
  type BatonEvent,
  ClientMessage,
  type EventMessage,
  type EventsResponse,
  PROTOCOL_VERSION,
  projectName,
  type ServerMessage,
  type SessionInfo,
  type Subscription,
} from "@baton/core";
import type { Logger } from "pino";
import type { EventLog, LogEntry } from "./event-log.js";
import type { EventSink, PublishOptions } from "./sink.js";

/** What the hub needs from a WebSocket. */
export interface ClientSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly bufferedAmount: number;
}

export type HubOptions = {
  /** Numbered events kept for replay; owns seq and epoch. */
  log: EventLog;
  /** `/sessions` lists sessions the hub received an event for this recently. */
  activeWindowMs: number;
  /** A live client whose unsent data exceeds this is disconnected. Default 16 MB. */
  maxClientBufferBytes?: number;
  /** Replay pauses while a client has more than this unsent. Default 1 MB. */
  replayHighWaterBytes?: number;
  /** A replay that can't make progress for this long drops the client. Default 30 s. */
  replayStallMs?: number;
  logger: Logger;
  now?: () => number;
};

type SubscribeRequest = {
  session: Subscription;
  lastSeq?: number | undefined;
  epoch?: string | undefined;
};

export type Client = {
  socket: ClientSocket;
  session: Subscription;
  /** False while the log is being replayed; live events stay in the log until then. */
  live: boolean;
  /** Bumped on every (re)subscribe so a superseded replay stops. */
  generation: number;
};

type SessionState = {
  projectPath: string;
  /** Latest event `ts`, as written in the transcript. */
  lastActivity: string;
  lastMs: number;
  /** When the hub last received an event for it (hub clock, so transcript clock skew doesn't matter). */
  seenMs: number;
  events: number;
  /** Daemon the session streams from, on a team server. */
  source?: string;
};

/** Close code for a client that can't keep up (RFC 6455 "try again later"). */
const CLOSE_TOO_SLOW = 1013;
const REPLAY_BATCH = 256;
const REPLAY_POLL_MS = 10;

/**
 * The local delivery point: numbers events into an EventLog and fans them out
 * to subscribed WebSocket clients, replaying the log to clients that join or
 * reconnect.
 */
export class Hub implements EventSink {
  readonly #log: EventLog;
  readonly #sessions = new Map<string, SessionState>();
  readonly #clients = new Set<Client>();
  readonly #maxClientBufferBytes: number;
  readonly #replayHighWater: number;
  readonly #replayStallMs: number;
  readonly #now: () => number;

  constructor(readonly options: HubOptions) {
    this.#log = options.log;
    this.#maxClientBufferBytes = options.maxClientBufferBytes ?? 16 * 1024 * 1024;
    this.#replayHighWater = options.replayHighWaterBytes ?? 1024 * 1024;
    this.#replayStallMs = options.replayStallMs ?? 30_000;
    this.#now = options.now ?? Date.now;
  }

  get epoch(): string {
    return this.#log.epoch;
  }

  /** Latest seq assigned (0 before any event). */
  get seq(): number {
    return this.#log.lastSeq;
  }

  get clientCount(): number {
    return this.#clients.size;
  }

  publish(events: readonly BatonEvent[], options: PublishOptions = {}): void {
    this.accept(events, options);
  }

  /**
   * Numbers, stores and fans out events. Returns how many were new: an event
   * whose id the log already holds is skipped, so a daemon may resend freely.
   */
  accept(events: readonly BatonEvent[], options: PublishOptions = {}): number {
    let accepted = 0;
    for (const event of events) {
      const entry = this.#log.append(event, options.backlog ?? false);
      if (!entry) continue; // already held, e.g. history published again
      accepted++;
      this.#track(event, options.source);
      let data: string | undefined;
      for (const client of this.#clients) {
        if (!client.live || !matches(client.session, event)) continue;
        data ??= JSON.stringify(eventMessage(entry));
        this.#sendLive(client, data);
      }
    }
    return accepted;
  }

  /** Log entries after `after`, oldest first, for `GET /events`. */
  entries(after: number, limit: number): EventsResponse {
    return {
      epoch: this.#log.epoch,
      firstSeq: this.#log.firstSeq,
      lastSeq: this.#log.lastSeq,
      events: this.#log.read(after, limit).map(eventMessage),
    };
  }

  /** Registers a client, greets it, and starts replaying what it asked for. */
  connect(socket: ClientSocket, request: SubscribeRequest): Client {
    const client: Client = { socket, session: request.session, live: false, generation: 0 };
    this.#clients.add(client);
    this.#subscribe(client, request);
    return client;
  }

  disconnect(client: Client): void {
    this.#clients.delete(client);
  }

  /** Handles one message from a client; invalid ones get an `error` reply. */
  receive(client: Client, raw: string): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.#write(client, { type: "error", message: "message is not valid JSON" });
      return;
    }
    const msg = ClientMessage.safeParse(json);
    if (!msg.success) {
      const issue = msg.error.issues[0];
      this.#write(client, {
        type: "error",
        message:
          `invalid message: ${issue?.path.join(".") || "(root)"} ${issue?.message ?? ""}`.trim(),
      });
      return;
    }
    this.#subscribe(client, msg.data);
  }

  /** Sessions active within the window, most recent first. */
  sessions(): SessionInfo[] {
    const cutoff = this.#now() - this.options.activeWindowMs;
    return [...this.#sessions.entries()]
      .filter(([, s]) => s.seenMs >= cutoff)
      .sort(([, a], [, b]) => b.lastMs - a.lastMs || b.seenMs - a.seenMs)
      .map(([sessionId, s]) => ({
        sessionId,
        projectPath: s.projectPath,
        projectName: projectName(s.projectPath),
        lastActivity: s.lastActivity,
        events: s.events,
        ...(s.source === undefined ? {} : { source: s.source }),
      }));
  }

  #subscribe(client: Client, request: SubscribeRequest): void {
    client.session = request.session;
    client.live = false;
    const generation = ++client.generation;
    this.#write(client, {
      type: "hello",
      protocol: PROTOCOL_VERSION,
      epoch: this.#log.epoch,
      seq: this.#log.lastSeq,
      session: request.session,
    });

    const { lastSeq } = request;
    const resumable =
      lastSeq !== undefined &&
      (request.epoch === undefined || request.epoch === this.#log.epoch) &&
      lastSeq <= this.#log.lastSeq;
    // A fresh client starts at the oldest event held; only a resuming one can have a gap.
    const after = resumable ? lastSeq : this.#log.firstSeq - 1;
    this.#replay(client, generation, after).catch((err: unknown) => {
      this.options.logger.warn({ err }, "replay to a WebSocket client failed");
    });
  }

  /**
   * Sends the log after `after`, pausing whenever the client has too much
   * unsent data, then marks the client live. Events published while it waits
   * land in the log and are picked up by the next batch.
   */
  async #replay(client: Client, generation: number, after: number): Promise<void> {
    let cursor = after;
    const current = () => client.generation === generation && this.#clients.has(client);
    while (current()) {
      const first = this.#log.firstSeq;
      if (cursor + 1 < first) {
        // The missed events already left the log (before, or while, this replay waited).
        this.#write(client, { type: "gap", fromSeq: cursor + 1, toSeq: first - 1 });
        cursor = first - 1;
      }
      const batch = this.#log.read(cursor, REPLAY_BATCH);
      if (batch.length === 0) {
        client.live = true;
        return;
      }
      for (const entry of batch) {
        cursor = entry.seq;
        if (!matches(client.session, entry.event)) continue;
        this.#write(client, eventMessage(entry));
        if (client.socket.bufferedAmount > this.#replayHighWater) break;
      }
      // Only yield when the socket is backed up, so a client that keeps up goes
      // live in the same tick and no live event can get ahead of the replay.
      if (client.socket.bufferedAmount > this.#replayHighWater) {
        if (!(await this.#drained(client, current))) return;
      }
    }
  }

  /** Waits until the client's unsent data is below the high-water mark. */
  async #drained(client: Client, current: () => boolean): Promise<boolean> {
    const started = Date.now();
    while (client.socket.bufferedAmount > this.#replayHighWater) {
      if (!current()) return false;
      if (Date.now() - started > this.#replayStallMs) {
        this.#drop(client, "replay stalled");
        return false;
      }
      await new Promise((r) => setTimeout(r, REPLAY_POLL_MS));
    }
    return current();
  }

  #track(event: BatonEvent, source: string | undefined): void {
    const ms = Date.parse(event.ts);
    const seenMs = this.#now();
    const s = this.#sessions.get(event.sessionId);
    if (!s) {
      this.#sessions.set(event.sessionId, {
        projectPath: event.projectPath,
        lastActivity: event.ts,
        lastMs: ms,
        seenMs,
        events: 1,
        ...(source === undefined ? {} : { source }),
      });
      return;
    }
    s.events++;
    if (source !== undefined) s.source = source;
    s.seenMs = seenMs;
    if (event.projectPath) s.projectPath = event.projectPath;
    if (ms >= s.lastMs) {
      s.lastMs = ms;
      s.lastActivity = event.ts;
    }
  }

  #sendLive(client: Client, data: string): void {
    if (client.socket.bufferedAmount > this.#maxClientBufferBytes) {
      this.#drop(client, "client too slow");
      return;
    }
    client.socket.send(data);
  }

  #write(client: Client, msg: ServerMessage): void {
    if (this.#clients.has(client)) client.socket.send(JSON.stringify(msg));
  }

  #drop(client: Client, reason: string): void {
    this.options.logger.warn({ reason }, "disconnecting a WebSocket client that is not keeping up");
    this.#clients.delete(client);
    client.socket.close(CLOSE_TOO_SLOW, reason);
  }
}

const matches = (session: Subscription, event: BatonEvent) =>
  session === "all" || session === event.sessionId;

const eventMessage = (entry: LogEntry): EventMessage => ({
  type: "event",
  seq: entry.seq,
  ...(entry.backlog ? { backlog: true } : {}),
  event: entry.event,
});
