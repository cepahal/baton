import {
  type BatonEvent,
  classifyDomain,
  DOMAIN_WINDOW,
  type DomainClassification,
  type DomainLabel,
  type RepoInfo,
  type SessionDomain,
} from "@baton/core";

/**
 * Suggests a label when the rules are unsure. Synchronous: returns what it
 * already knows and may start a lookup for next time.
 */
export interface DomainTieBreaker {
  advise(
    sessionId: string,
    rules: DomainClassification,
    events: readonly BatonEvent[],
  ): DomainLabel | undefined;
  forget?(sessionId: string): void;
}

/** Below this the rules' answer goes to the tie-breaker. */
export const TIE_BREAK_BELOW = 0.5;

type Entry = {
  events: BatonEvent[];
  override?: DomainLabel;
  /** The last rules answer, until events or the folder change. */
  rules?: { key: string; value: DomainClassification } | undefined;
};

/** Repo info kept for at most this many session folders. */
const MAX_REPO_DIRS = 2000;

/**
 * Per-session inputs to domain classification (latest events, git identity,
 * manual override) and the rule that combines them: an override wins, then a
 * confident rules answer, then the tie-breaker's suggestion.
 */
export class SessionDomains {
  readonly #entries = new Map<string, Entry>();
  /** Git identity per session cwd (`projectPath`). */
  readonly #repos = new Map<string, RepoInfo>();

  constructor(readonly tieBreaker?: DomainTieBreaker) {}

  #entry(sessionId: string): Entry {
    let e = this.#entries.get(sessionId);
    if (!e) {
      e = { events: [] };
      this.#entries.set(sessionId, e);
    }
    return e;
  }

  record(event: BatonEvent): void {
    const e = this.#entry(event.sessionId);
    e.events.push(event);
    e.rules = undefined;
    if (e.events.length > 2 * DOMAIN_WINDOW) e.events.splice(0, e.events.length - DOMAIN_WINDOW);
  }

  setRepo(projectPath: string, repo: RepoInfo): void {
    this.#repos.set(projectPath, repo);
    // Bounded: cwds come and go; an evicted one is re-sent with its session's next batch.
    if (this.#repos.size > MAX_REPO_DIRS) {
      const oldest = this.#repos.keys().next().value;
      if (oldest !== undefined) this.#repos.delete(oldest);
    }
  }

  /** Forgets a session (it left the hub's memory). */
  forget(sessionId: string): void {
    this.#entries.delete(sessionId);
    this.tieBreaker?.forget?.(sessionId);
  }

  repo(projectPath: string): RepoInfo | undefined {
    return this.#repos.get(projectPath);
  }

  /** Pins a label (`null` clears it). */
  setOverride(sessionId: string, label: DomainLabel | null): void {
    const e = this.#entry(sessionId);
    if (label === null) delete e.override;
    else e.override = label;
  }

  domain(sessionId: string, projectPath: string): SessionDomain {
    const e = this.#entries.get(sessionId);
    if (e?.override !== undefined) {
      return { label: e.override, confidence: 1, reasons: ["set by hand"], source: "override" };
    }
    const events = (e?.events ?? []).slice(-DOMAIN_WINDOW);
    const relativeCwd = this.#repos.get(projectPath)?.relativeCwd ?? null;
    // Classifying is cheap but runs for every session on every /sessions call: cache it
    // until the session's events or folder change.
    const key = `${projectPath}|${relativeCwd ?? ""}`;
    let rules = e?.rules?.key === key ? e.rules.value : undefined;
    if (!rules) {
      rules = classifyDomain(events, {
        repoRelativeCwd: relativeCwd,
        repoRoot: repoRoot(projectPath, relativeCwd),
      });
      if (e) e.rules = { key, value: rules };
    }
    if (rules.confidence >= TIE_BREAK_BELOW || !this.tieBreaker || events.length === 0) {
      return { ...rules, source: "rules" };
    }
    const label = this.tieBreaker.advise(sessionId, rules, events);
    if (label === undefined || label === "unknown") return { ...rules, source: "rules" };
    return {
      label,
      confidence: TIE_BREAK_BELOW,
      reasons: [
        `model tie-break (rules said ${rules.label} at ${rules.confidence})`,
        ...rules.reasons,
      ],
      source: "llm",
    };
  }
}

/** `projectPath` with its repo-relative tail removed; `projectPath` itself outside git. */
export function repoRoot(projectPath: string, relativeCwd: string | null): string {
  if (!relativeCwd) return projectPath;
  const tail = relativeCwd.split("/");
  const parts = projectPath.split(/[\\/]/);
  const end = parts.slice(-tail.length);
  const same =
    end.length === tail.length && end.every((p, i) => p.toLowerCase() === tail[i]?.toLowerCase());
  return same ? projectPath.slice(0, projectPath.length - relativeCwd.length - 1) : projectPath;
}
