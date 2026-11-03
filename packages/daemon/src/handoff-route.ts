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

type Attached = { socket: { send(data: string): void }; machine: string };

/** `baton serve`: messages go down the `/ingest` socket of the named daemon. */
export class IngestRoute implements HandoffRoute {
  readonly #sockets = new Map<string, Attached>();

  /**
   * Registers a daemon's connection. A reconnect from the same machine
   * replaces the old socket (it may not have noticed its drop yet); a live
   * name held by a different machine is refused, so two teammates with the
   * same name can't receive each other's handoffs.
   */
  attach(daemon: string, socket: { send(data: string): void }, machine: string): boolean {
    const held = this.#sockets.get(daemon);
    if (held && held.machine !== machine) return false;
    this.#sockets.set(daemon, { socket, machine });
    return true;
  }

  /** Forgets `socket` unless a newer connection of the same daemon replaced it. */
  detach(daemon: string, socket: { send(data: string): void }): void {
    if (this.#sockets.get(daemon)?.socket === socket) this.#sockets.delete(daemon);
  }

  offer(daemon: string | undefined, message: HandoffOfferMessage): boolean {
    const held = daemon === undefined ? undefined : this.#sockets.get(daemon);
    if (!held) return false;
    held.socket.send(JSON.stringify(message));
    return true;
  }
}
