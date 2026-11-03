import type { Logger } from "pino";
import { z } from "zod";

/** Where Ollama listens unless `BATON_OLLAMA_URL` says otherwise. */
export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

/** One entry of `GET /api/tags`. Only the fields the picker reads. */
export const OllamaModel = z.object({
  name: z.string().min(1),
  size: z.number().nonnegative().optional(),
  details: z
    .object({
      parameter_size: z.string().optional(),
      family: z.string().optional(),
      families: z.array(z.string()).nullable().optional(),
    })
    .partial()
    .optional(),
  capabilities: z.array(z.string()).optional(),
});
export type OllamaModel = z.infer<typeof OllamaModel>;

const TagsResponse = z.object({ models: z.array(z.unknown()).default([]) });
const ChatResponse = z.object({
  message: z.object({ content: z.string() }).partial().optional(),
  error: z.string().optional(),
});

/** Billions of parameters from Ollama's "1.9B" / "270M" labels. */
export function parameterBillions(label: string | undefined): number | undefined {
  const m = label?.trim().match(/^(\d+(?:\.\d+)?)\s*([KMBT])$/i);
  if (!m?.[1] || !m[2]) return undefined;
  const scale = { K: 1e-6, M: 1e-3, B: 1, T: 1e3 }[m[2].toUpperCase() as "K" | "M" | "B" | "T"];
  return Number(m[1]) * scale;
}

const EMBEDDING_FAMILIES = /bert|embed|nomic/i;

/** Whether the model can write text (not an embedding-only model). */
function canComplete(model: OllamaModel): boolean {
  if (model.capabilities) return model.capabilities.includes("completion");
  const families = [model.details?.family ?? "", ...(model.details?.families ?? [])];
  return !EMBEDDING_FAMILIES.test(model.name) && !families.some((f) => EMBEDDING_FAMILIES.test(f));
}

/**
 * The fastest installed model that can write text: fewest parameters, then
 * smallest download, then name (so the choice is stable). Undefined if none.
 */
export function pickFastestModel(models: readonly OllamaModel[]): OllamaModel | undefined {
  const usable = models.filter(canComplete);
  const key = (m: OllamaModel) => parameterBillions(m.details?.parameter_size) ?? Infinity;
  return [...usable].sort(
    (a, b) =>
      key(a) - key(b) ||
      (a.size ?? Infinity) - (b.size ?? Infinity) ||
      a.name.localeCompare(b.name),
  )[0];
}

export type OllamaOptions = {
  url: string;
  /** Use this model instead of picking one. */
  model?: string | undefined;
  logger: Logger;
  fetch?: typeof fetch;
  /** Per-request timeout. Small local models answer well inside this. */
  timeoutMs?: number;
  now?: () => number;
};

/** After Ollama can't be reached, wait this long before trying again. */
export const OLLAMA_RETRY_MS = 60_000;

/**
 * A small client for a local Ollama: picks a model once (re-picks if it
 * disappears) and sends single-turn prompts. Never throws: callers get
 * undefined and fall back to their non-model path.
 */
export class Ollama {
  readonly #url: string;
  readonly #fixed: string | undefined;
  readonly #log: Logger;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  #picked: Promise<OllamaModel | undefined> | undefined;
  #failedAt = -Infinity;
  #warned = false;
  readonly #now: () => number;
  /** Requests run one at a time: a local model serves one well, many slowly. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: OllamaOptions) {
    this.#url = options.url.replace(/\/+$/, "");
    this.#fixed = options.model;
    this.#log = options.logger;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#now = options.now ?? Date.now;
  }

  /** The model prompts go to, or undefined if Ollama is down or has none. */
  model(): Promise<OllamaModel | undefined> {
    if (this.#fixed) return Promise.resolve({ name: this.#fixed });
    if (!this.#picked && this.#now() - this.#failedAt < OLLAMA_RETRY_MS) {
      return Promise.resolve(undefined);
    }
    this.#picked ??= this.#pick();
    return this.#picked;
  }

  async #pick(): Promise<OllamaModel | undefined> {
    try {
      const res = await this.#fetch(`${this.#url}/api/tags`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const tags = TagsResponse.parse(await res.json());
      const models = tags.models.flatMap((m) => {
        const parsed = OllamaModel.safeParse(m);
        return parsed.success ? [parsed.data] : [];
      });
      const chosen = pickFastestModel(models);
      if (chosen) this.#log.info({ model: chosen.name }, "ollama summarizer model");
      else this.#warnOnce("ollama has no text models installed; summaries use the heuristic draft");
      if (!chosen) this.#failed();
      return chosen;
    } catch (err) {
      this.#warnOnce(
        `ollama isn't reachable at ${this.#url}; summaries use the heuristic draft`,
        err,
      );
      this.#failed();
      return undefined;
    }
  }

  #failed() {
    this.#picked = undefined;
    this.#failedAt = this.#now();
  }

  #warnOnce(message: string, err?: unknown) {
    if (this.#warned) return;
    this.#warned = true;
    this.#log.warn(err ? { err } : {}, message);
  }

  /** Sends one prompt; resolves the reply text, or undefined on any failure. */
  ask(prompt: string, options: { json?: boolean } = {}): Promise<string | undefined> {
    const run = this.#queue.then(() => this.#ask(prompt, options));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #ask(prompt: string, options: { json?: boolean }): Promise<string | undefined> {
    const model = await this.model();
    if (!model) return undefined;
    try {
      const res = await this.#fetch(`${this.#url}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(this.#timeoutMs),
        body: JSON.stringify({
          model: model.name,
          stream: false,
          messages: [{ role: "user", content: prompt }],
          ...(options.json ? { format: "json" } : {}),
          // Thinking makes small models slow and is not needed for these tasks.
          ...(model.capabilities?.includes("thinking") ? { think: false } : {}),
          options: { temperature: 0.2 },
        }),
      });
      const body = ChatResponse.safeParse(await res.json().catch(() => ({})));
      if (!res.ok || !body.success || body.data.error) {
        // The model may have been removed: pick again next time.
        if (res.status === 404) this.#picked = undefined;
        this.#log.warn(
          { status: res.status, error: body.success ? body.data.error : undefined },
          "ollama request failed",
        );
        return undefined;
      }
      return body.data.message?.content ?? "";
    } catch (err) {
      this.#log.warn({ err }, "ollama request failed");
      return undefined;
    }
  }
}
