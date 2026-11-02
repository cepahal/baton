import type { BatonEvent } from "@baton/core";

export type PublishOptions = {
  /** The events are history read at startup, not activity seen live. */
  backlog?: boolean;
  /** Display name of the daemon that sent the events (team server ingest only). */
  source?: string;
};

/**
 * Where the watcher delivers events. The local hub implements it today; a
 * remote/team server can replace it without the watcher changing.
 */
export interface EventSink {
  /** Events arrive in order per session. May be async; the watcher awaits it. */
  publish(events: readonly BatonEvent[], options?: PublishOptions): void | Promise<void>;
}
