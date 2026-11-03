import type { BatonEvent, RepoInfo } from "@baton/core";
import type { RepoResolver } from "./repo-info.js";
import type { EventSink, PublishOptions } from "./sink.js";

/**
 * Wraps a sink so publishes carry the git identity of their events' project
 * directories (`options.repos`). The watcher stays unaware of git.
 *
 * Events are never held back for git: a directory not looked up yet is
 * published without repo info, and its info follows in an event-less publish
 * once git answers (the hub applies it to every session in that directory; a
 * `RemoteSink` sends it with the next batch).
 */
export class RepoTaggingSink implements EventSink {
  readonly #pending = new Set<string>();

  constructor(
    readonly inner: EventSink,
    readonly resolver: RepoResolver,
  ) {}

  async publish(events: readonly BatonEvent[], options: PublishOptions = {}): Promise<void> {
    const repos: Record<string, RepoInfo> = {};
    for (const dir of new Set(events.map((e) => e.projectPath))) {
      if (dir === "") continue;
      const known = this.resolver.cached(dir);
      if (known) repos[dir] = known;
      if (!this.resolver.fresh(dir)) this.#lookUp(dir);
    }
    const tagged = Object.keys(repos).length > 0;
    await this.inner.publish(
      events,
      tagged ? { ...options, repos: { ...options.repos, ...repos } } : options,
    );
  }

  /** Resolves when every lookup started so far has been passed on. For tests. */
  async settled(): Promise<void> {
    while (this.#pending.size > 0) await new Promise((r) => setTimeout(r, 5));
  }

  #lookUp(dir: string): void {
    if (this.#pending.has(dir)) return;
    this.#pending.add(dir);
    void this.resolver
      .resolve(dir)
      .then((info) => this.inner.publish([], { repos: { [dir]: info } }))
      .catch(() => {})
      .finally(() => this.#pending.delete(dir));
  }
}
