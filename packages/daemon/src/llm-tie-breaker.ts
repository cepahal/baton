import Anthropic from "@anthropic-ai/sdk";
import {
  type BatonEvent,
  DOMAIN_LABELS,
  type DomainClassification,
  DomainLabel,
  touchedPaths,
} from "@baton/core";
import type { Logger } from "pino";
import type { DomainTieBreaker } from "./session-domains.js";

/** Sends a prompt to a model, resolves its text reply. */
export type AskModel = (prompt: string) => Promise<string>;

export type LlmTieBreakerOptions = {
  ask: AskModel;
  logger: Logger;
  /** A session is asked again at most this often. Default 5 minutes. */
  minIntervalMs?: number;
  now?: () => number;
};

type Cached = { at: number; label?: DomainLabel; pending: boolean };

const MAX_PROMPTS = 5;
const MAX_PROMPT_CHARS = 300;
const MAX_PATHS = 20;

/**
 * Asks a model for a session's domain when the rules are unsure. Answers
 * from cache; a session is re-asked at most every `minIntervalMs`, in the
 * background, so `/sessions` never waits on the network.
 */
export class LlmTieBreaker implements DomainTieBreaker {
  readonly #cache = new Map<string, Cached>();
  readonly #ask: AskModel;
  readonly #log: Logger;
  readonly #minIntervalMs: number;
  readonly #now: () => number;

  constructor(options: LlmTieBreakerOptions) {
    this.#ask = options.ask;
    this.#log = options.logger;
    this.#minIntervalMs = options.minIntervalMs ?? 5 * 60_000;
    this.#now = options.now ?? Date.now;
  }

  /** Drops a session's cached answer. */
  forget(sessionId: string): void {
    this.#cache.delete(sessionId);
  }

  advise(
    sessionId: string,
    rules: DomainClassification,
    events: readonly BatonEvent[],
  ): DomainLabel | undefined {
    const cached = this.#cache.get(sessionId);
    if (cached && (cached.pending || this.#now() - cached.at < this.#minIntervalMs))
      return cached.label;
    const entry: Cached = {
      at: this.#now(),
      pending: true,
      ...(cached?.label ? { label: cached.label } : {}),
    };
    this.#cache.set(sessionId, entry);
    void this.#ask(tieBreakPrompt(rules, events))
      .then((reply) => {
        const label = parseLabel(reply);
        if (label) entry.label = label;
        else
          this.#log.warn(
            { sessionId, reply: reply.slice(0, 80) },
            "domain tie-break gave no label",
          );
      })
      .catch((err: unknown) => this.#log.warn({ sessionId, err }, "domain tie-break failed"))
      .finally(() => {
        entry.pending = false;
        entry.at = this.#now();
      });
    return entry.label;
  }
}

/** The first domain label in a reply, if any. */
export function parseLabel(reply: string): DomainLabel | undefined {
  for (const word of reply.toLowerCase().match(/[a-z]+/g) ?? []) {
    const parsed = DomainLabel.safeParse(word);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

/** A short digest of the session: files it edited and its latest prompts (truncated). */
export function tieBreakPrompt(rules: DomainClassification, events: readonly BatonEvent[]): string {
  const paths = [...new Set(events.flatMap(touchedPaths))].slice(-MAX_PATHS);
  const prompts = events
    .filter((e) => e.kind === "prompt")
    .slice(-MAX_PROMPTS)
    .map((e) => e.text.replace(/\s+/g, " ").slice(0, MAX_PROMPT_CHARS));
  const cwd = events.at(-1)?.projectPath ?? "";
  return [
    `Classify which area of software work this coding session is about. Answer with exactly one word from: ${DOMAIN_LABELS.join(", ")}.`,
    "",
    `Working directory: ${cwd}`,
    `Files edited: ${paths.length > 0 ? paths.join(", ") : "(none)"}`,
    "Recent prompts:",
    ...(prompts.length > 0 ? prompts.map((p) => `- ${p}`) : ["(none)"]),
    "",
    `A rule-based classifier guessed "${rules.label}" (confidence ${rules.confidence}) because: ${rules.reasons.join("; ")}.`,
  ].join("\n");
}

/** `AskModel` over the Claude API. Credentials come from the environment (`ANTHROPIC_API_KEY`). */
export function anthropicAsk(model: string, maxTokens = 1024): AskModel {
  // One retry and a bounded wait: a draft waits on this, so fail to the heuristic fast.
  const client = new Anthropic({ timeout: 90_000, maxRetries: 1 });
  return async (prompt) => {
    const response = await client.beta.messages.create({
      model,
      max_tokens: maxTokens,
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [{ role: "user", content: prompt }],
    });
    if (response.stop_reason === "refusal") return "";
    return response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  };
}
