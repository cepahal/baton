import {
  type CanvasMessage,
  type EventMessage,
  type GapMessage,
  type HandoffMessage,
  type NotesMessage,
  ServerMessage,
  type SessionRemovedMessage,
} from "@baton/core";
import { type BackoffOptions, backoffDelay, DEFAULT_BACKOFF } from "./backoff.js";

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "stopped";

export type ConnectionState = {
  status: ConnectionStatus;
  /** Failed attempts since the last connection that stayed up for `stableMs`. */
  attempt: number;
  /** When the next reconnect fires (`now()` clock). Unset while a socket is opening. */
  retryAt?: number;
  /** Hub epoch from the last `hello`. */
  epoch?: string;
  /** Last hub seq received; sent as `lastSeq` on reconnect. */
  lastSeq?: number;
  /** `gap` messages received: events the hub no longer had for us. */
  gaps: number;
  /** Last `error` message from the hub. */
  error?: string;
};

/** What the manager needs from a socket. `createBrowserSocket` adapts a real WebSocket. */
export type SocketHandlers = {
  onOpen(): void;
  onMessage(data: unknown): void;
  onClose(): void;
};
export type SocketHandle = { close(): void };
export type SocketFactory = (url: string, handlers: SocketHandlers) => SocketHandle;

export type ConnectionOptions = {
  /** Base WebSocket URL, e.g. `ws://127.0.0.1:7777/ws`. */
  url: string;
  onEvent(message: EventMessage): void;
  onGap?(message: GapMessage): void;
  /** Shared canvas positions: the full set after connecting, then each change. */
  onCanvas?(message: CanvasMessage): void;
  /** A handoff was sent or answered. */
  onHandoff?(message: HandoffMessage): void;
  /** Sticky notes: every note after connecting, then each change. */
  onNotes?(message: NotesMessage): void;
  /** Someone removed a session from the hub. */
  onSessionRemoved?(message: SessionRemovedMessage): void;
  createSocket?: SocketFactory;
  backoff?: BackoffOptions;
  /**
   * How long a socket must stay open before backoff resets and the last hub
   * error clears. A hub that accepts and then closes (bad query, stalled
   * replay, slow client) keeps backing off and its error stays visible.
   */
  stableMs?: number;
  random?: () => number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

export const createBrowserSocket: SocketFactory = (url, handlers) => {
  const ws = new WebSocket(url);
  ws.onopen = () => handlers.onOpen();
  ws.onmessage = (ev) => handlers.onMessage(ev.data);
  // `error` is always followed by `close`, so reconnecting from `close` covers both.
  ws.onclose = () => handlers.onClose();
  return { close: () => ws.close() };
};

export const DEFAULT_STABLE_MS = 5000;

type StatePatch = { [K in keyof ConnectionState]?: ConnectionState[K] | undefined };

/**
 * One WebSocket to the hub, subscribed to every session. Reconnects with
 * backoff and resumes with `lastSeq` + `epoch`, so the hub replays only what
 * was missed. Every server message is validated before use.
 */
export class ConnectionManager {
  #state: ConnectionState = { status: "stopped", attempt: 0, gaps: 0 };
  readonly #listeners = new Set<() => void>();
  readonly #options: ConnectionOptions;
  #socket: SocketHandle | undefined;
  #timer: unknown;
  #stableTimer: unknown;
  /** Bumped on every connect/stop so callbacks from an old socket are ignored. */
  #generation = 0;

  constructor(options: ConnectionOptions) {
    this.#options = options;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  getState = (): ConnectionState => this.#state;

  start(): void {
    if (this.#state.status !== "stopped") return;
    this.#connect("connecting");
  }

  stop(): void {
    this.#generation++;
    this.#clearTimer();
    this.#clearStableTimer();
    this.#socket?.close();
    this.#socket = undefined;
    this.#update({ status: "stopped", retryAt: undefined });
  }

  /** Skips the remaining backoff and reconnects now. */
  retryNow(): void {
    if (this.#state.status !== "reconnecting" || this.#socket) return;
    this.#clearTimer();
    this.#connect("reconnecting");
  }

  /** The socket URL, with `lastSeq` and `epoch` once we have them. */
  url(): string {
    const { lastSeq, epoch } = this.#state;
    const params = new URLSearchParams({ session: "all" });
    if (lastSeq !== undefined && epoch !== undefined) {
      params.set("lastSeq", String(lastSeq));
      params.set("epoch", epoch);
    }
    return `${this.#options.url}?${params}`;
  }

  #connect(status: "connecting" | "reconnecting"): void {
    const generation = ++this.#generation;
    const live = () => generation === this.#generation;
    this.#update({ status, retryAt: undefined });
    const create = this.#options.createSocket ?? createBrowserSocket;
    this.#socket = create(this.url(), {
      onOpen: () => {
        if (!live()) return;
        this.#update({ status: "open" });
        this.#stableTimer = this.#setTimer(() => {
          this.#stableTimer = undefined;
          if (live()) this.#update({ attempt: 0, error: undefined });
        }, this.#options.stableMs ?? DEFAULT_STABLE_MS);
      },
      onMessage: (data) => {
        if (live()) this.#receive(data);
      },
      onClose: () => {
        if (!live()) return;
        this.#socket = undefined;
        this.#clearStableTimer();
        this.#scheduleReconnect();
      },
    });
  }

  #scheduleReconnect(): void {
    const { attempt } = this.#state;
    const options = this.#options;
    const delay = backoffDelay(attempt, options.backoff ?? DEFAULT_BACKOFF, options.random);
    const now = options.now ?? Date.now;
    this.#update({ status: "reconnecting", attempt: attempt + 1, retryAt: now() + delay });
    this.#timer = this.#setTimer(() => {
      this.#timer = undefined;
      this.#connect("reconnecting");
    }, delay);
  }

  #setTimer(fn: () => void, ms: number): unknown {
    return this.#options.setTimer ? this.#options.setTimer(fn, ms) : setTimeout(fn, ms);
  }

  #cancel(handle: unknown): void {
    if (this.#options.clearTimer) this.#options.clearTimer(handle);
    else clearTimeout(handle as ReturnType<typeof setTimeout>);
  }

  #clearTimer(): void {
    if (this.#timer === undefined) return;
    this.#cancel(this.#timer);
    this.#timer = undefined;
  }

  #clearStableTimer(): void {
    if (this.#stableTimer === undefined) return;
    this.#cancel(this.#stableTimer);
    this.#stableTimer = undefined;
  }

  #receive(data: unknown): void {
    if (typeof data !== "string") return;
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    const parsed = ServerMessage.safeParse(json);
    if (!parsed.success) return;
    const message = parsed.data;
    switch (message.type) {
      case "hello":
        // Seqs from another epoch mean nothing here. The hub sends its whole
        // buffer again, and the store drops what it already has by event id.
        if (message.epoch !== this.#state.epoch) {
          this.#update({ epoch: message.epoch, lastSeq: undefined });
        }
        return;
      case "event":
        this.#update({ lastSeq: Math.max(message.seq, this.#state.lastSeq ?? 0) }, false);
        this.#options.onEvent(message);
        return;
      case "gap":
        this.#update({ gaps: this.#state.gaps + 1 });
        this.#options.onGap?.(message);
        return;
      case "error":
        this.#update({ error: message.message });
        return;
      case "canvas":
        this.#options.onCanvas?.(message);
        return;
      case "handoff":
        this.#options.onHandoff?.(message);
        return;
      case "notes":
        this.#options.onNotes?.(message);
        return;
      case "session_removed":
        this.#options.onSessionRemoved?.(message);
        return;
    }
  }

  /** Applies a patch (`undefined` removes a key). `notify: false` for seq bookkeeping. */
  #update(patch: StatePatch, notify = true): void {
    const next: StatePatch = { ...this.#state };
    for (const key of Object.keys(patch) as (keyof ConnectionState)[]) {
      if (patch[key] === undefined) delete next[key];
      else Object.assign(next, { [key]: patch[key] });
    }
    this.#state = next as ConnectionState;
    if (notify) for (const l of this.#listeners) l();
  }
}
