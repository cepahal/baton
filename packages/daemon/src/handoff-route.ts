import { randomBytes } from "node:crypto";
import type {
  HandoffCode,
  HandoffCodeMessage,
  HandoffOfferMessage,
  HandoffWriteResult,
  HandoffWrittenMessage,
} from "@baton/core";
import type { Inbox } from "./inbox.js";

/** A sending daemon's answer to "attach my changes": the summary and, when there is one, the patch. */
export type CodeReply = { code: Omit<HandoffCode, "sha256">; patch?: Buffer };

/**
 * How handoff messages reach daemons. `daemon` is the session's daemon name on
 * a team server and undefined locally.
 *
 * The only requests a hub can make of a daemon are `write` (put an accepted
 * handoff's files in a folder) and `code` (send a shared session's
 * uncommitted changes). Both resolve undefined when the daemon isn't connected
 * or doesn't answer in time.
 */
export interface HandoffRoute {
  /** Returns false when the daemon isn't connected; the service resends when it connects. */
  offer(daemon: string | undefined, message: HandoffOfferMessage): boolean;
  write(
    daemon: string | undefined,
    id: string,
    folder: string | undefined,
  ): Promise<HandoffWriteResult | undefined>;
  code(daemon: string | undefined, sessionId: string): Promise<CodeReply | undefined>;
  /** The machine id of the connected daemon with this name. Undefined locally or when it is offline. */
  machineOf(daemon: string | undefined): string | undefined;
}

/** `baton start`: every session is on this machine, so the inbox is called directly. */
export function localRoute(
  inbox: Inbox,
  code: (sessionId: string) => Promise<CodeReply | undefined>,
): HandoffRoute {
  return {
    offer: (_daemon, message) => {
      inbox.receive(message);
      return true;
    },
    write: (_daemon, id, folder) => inbox.write(id, folder),
    code: (_daemon, sessionId) => code(sessionId),
    machineOf: () => undefined,
  };
}

/** How long the hub waits for a daemon to write an accepted handoff. */
export const WRITE_TIMEOUT_MS = 30_000;
/** How long the hub waits for a daemon to bundle a session's changes. */
export const CODE_TIMEOUT_MS = 60_000;

type Socket = { send(data: string): void };
type Attached = { socket: Socket; machine: string };
type Waiting = {
  daemon: string;
  socket: Socket;
  type: "handoff_written" | "handoff_code";
  resolve: (message: HandoffWrittenMessage | HandoffCodeMessage | undefined) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** `baton serve`: messages go down the `/ingest` socket of the named daemon. */
export class IngestRoute implements HandoffRoute {
  readonly #sockets = new Map<string, Attached>();
  readonly #waiting = new Map<string, Waiting>();

  constructor(readonly options: { writeTimeoutMs?: number; codeTimeoutMs?: number } = {}) {}

  /**
   * Registers a daemon's connection. A reconnect from the same machine
   * replaces the old socket (it may not have noticed its drop yet); a live
   * name held by a different machine is refused, so two teammates with the
   * same name can't receive each other's handoffs.
   */
  attach(daemon: string, socket: Socket, machine: string): boolean {
    const held = this.#sockets.get(daemon);
    if (held && held.machine !== machine) return false;
    this.#sockets.set(daemon, { socket, machine });
    return true;
  }

  /** Forgets `socket` unless a newer connection of the same daemon replaced it. */
  detach(daemon: string, socket: Socket): void {
    if (this.#sockets.get(daemon)?.socket === socket) this.#sockets.delete(daemon);
    for (const [id, w] of this.#waiting) {
      if (w.socket === socket) this.#finish(id, undefined);
    }
  }

  machineOf(daemon: string | undefined): string | undefined {
    return daemon === undefined ? undefined : this.#sockets.get(daemon)?.machine;
  }

  offer(daemon: string | undefined, message: HandoffOfferMessage): boolean {
    const held = daemon === undefined ? undefined : this.#sockets.get(daemon);
    if (!held) return false;
    held.socket.send(JSON.stringify(message));
    return true;
  }

  async write(
    daemon: string | undefined,
    id: string,
    folder: string | undefined,
  ): Promise<HandoffWriteResult | undefined> {
    const reply = await this.#ask(
      daemon,
      "handoff_written",
      (requestId) => ({
        type: "handoff_write",
        requestId,
        id,
        ...(folder === undefined ? {} : { folder }),
      }),
      this.options.writeTimeoutMs ?? WRITE_TIMEOUT_MS,
    );
    if (reply?.type !== "handoff_written" || reply.id !== id) return undefined;
    return reply.result;
  }

  async code(daemon: string | undefined, sessionId: string): Promise<CodeReply | undefined> {
    const reply = await this.#ask(
      daemon,
      "handoff_code",
      (requestId) => ({ type: "handoff_code_request", requestId, sessionId }),
      this.options.codeTimeoutMs ?? CODE_TIMEOUT_MS,
    );
    if (reply?.type !== "handoff_code") return undefined;
    return {
      code: reply.code,
      ...(reply.patch === undefined ? {} : { patch: Buffer.from(reply.patch, "base64") }),
    };
  }

  /**
   * A daemon's answer to one of our requests. Ignored unless that daemon's
   * socket is the one we asked, so a daemon can't answer for another.
   */
  answer(
    daemon: string,
    socket: Socket,
    message: HandoffWrittenMessage | HandoffCodeMessage,
  ): void {
    const w = this.#waiting.get(message.requestId);
    if (!w || w.daemon !== daemon || w.socket !== socket || w.type !== message.type) return;
    this.#finish(message.requestId, message);
  }

  #ask(
    daemon: string | undefined,
    type: Waiting["type"],
    build: (requestId: string) => object,
    timeoutMs: number,
  ): Promise<HandoffWrittenMessage | HandoffCodeMessage | undefined> {
    const held = daemon === undefined ? undefined : this.#sockets.get(daemon);
    if (!held || daemon === undefined) return Promise.resolve(undefined);
    const requestId = randomBytes(12).toString("hex");
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.#finish(requestId, undefined), timeoutMs);
      this.#waiting.set(requestId, { daemon, socket: held.socket, type, resolve, timer });
      held.socket.send(JSON.stringify(build(requestId)));
    });
  }

  #finish(
    requestId: string,
    message: HandoffWrittenMessage | HandoffCodeMessage | undefined,
  ): void {
    const w = this.#waiting.get(requestId);
    if (!w) return;
    this.#waiting.delete(requestId);
    clearTimeout(w.timer);
    w.resolve(message);
  }
}
