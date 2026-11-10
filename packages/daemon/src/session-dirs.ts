import type { BatonEvent } from "@baton/core";
import type { EventSink, PublishOptions } from "./sink.js";

/** Most sessions remembered; the oldest go first. */
const MAX_SESSIONS = 5000;

/**
 * Remembers each session's working directory as its events pass through, so
 * the daemon can find a receiving session's folder (to write an accepted
 * handoff) or a sending session's (to bundle its changes). In the forwarder it
 * sits inside `SharingSink`, so it only knows shared sessions.
 */
export class SessionDirs implements EventSink {
  readonly #dirs = new Map<string, string>();

  constructor(readonly inner: EventSink) {}

  publish(events: readonly BatonEvent[], options?: PublishOptions): void | Promise<void> {
    for (const event of events) {
      if (this.#dirs.get(event.sessionId) === event.projectPath) continue;
      this.#dirs.delete(event.sessionId);
      this.#dirs.set(event.sessionId, event.projectPath);
      if (this.#dirs.size > MAX_SESSIONS) {
        const oldest = this.#dirs.keys().next().value;
        if (oldest !== undefined) this.#dirs.delete(oldest);
      }
    }
    return this.inner.publish(events, options);
  }

  get(sessionId: string): string | undefined {
    return this.#dirs.get(sessionId);
  }
}
