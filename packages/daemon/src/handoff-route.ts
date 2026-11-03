import type { HandoffOfferMessage } from "@baton/core";
import type { HandoffRoute } from "./handoff-service.js";
import type { Inbox } from "./inbox.js";

/** `baton start`: every session is on this machine, so offers go straight to its inbox. */
export function localRoute(inbox: Inbox): HandoffRoute {
  return {
    offer: (_daemon, message) => {
      inbox.receive(message);
      return true;
    },
  };
}

/** `baton serve`: messages go down the `/ingest` socket of the named daemon. */
export class IngestRoute implements HandoffRoute {
  readonly #sockets = new Map<string, { send(data: string): void }>();

  attach(daemon: string, socket: { send(data: string): void }): void {
    this.#sockets.set(daemon, socket);
  }

  /** Forgets `socket` unless a newer connection of the same daemon replaced it. */
  detach(daemon: string, socket: { send(data: string): void }): void {
    if (this.#sockets.get(daemon) === socket) this.#sockets.delete(daemon);
  }

  offer(daemon: string | undefined, message: HandoffOfferMessage): boolean {
    const socket = daemon === undefined ? undefined : this.#sockets.get(daemon);
    if (!socket) return false;
    socket.send(JSON.stringify(message));
    return true;
  }
}
