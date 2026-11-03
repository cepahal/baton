import type { Logger } from "pino";
import { DEFAULT_SUMMARIZER_MODEL, type SummarizerConfig } from "./config.js";
import { type AskModel, anthropicAsk, LlmTieBreaker } from "./llm-tie-breaker.js";
import { Ollama } from "./ollama.js";
import { modelSummarizer, type Summarizer } from "./summarizer.js";

/** What `BATON_SUMMARIZER` turns on: the handoff summarizer and the domain tie-break. */
export type Models = {
  summarize?: Summarizer | undefined;
  tieBreaker?: LlmTieBreaker | undefined;
};

/**
 * Builds the model-backed helpers from config. Both share one client, so a
 * local Ollama sees one request at a time from this process.
 */
export function modelsFor(config: SummarizerConfig, logger: Logger): Models {
  switch (config.summarizer) {
    case "off":
      return {};
    case "anthropic": {
      const model = config.summarizerModel ?? DEFAULT_SUMMARIZER_MODEL;
      logger.info({ model }, "summarizer: anthropic");
      return {
        summarize: modelSummarizer(anthropicAsk(model, 4096), logger),
        tieBreaker: new LlmTieBreaker({ ask: anthropicAsk(model), logger }),
      };
    }
    case "ollama": {
      const ollama = new Ollama({ url: config.ollamaUrl, model: config.summarizerModel, logger });
      const ask: AskModel = async (prompt) => {
        const reply = await ollama.ask(prompt);
        if (reply === undefined) throw new Error("ollama unavailable");
        return reply;
      };
      return {
        summarize: modelSummarizer((prompt) => ollama.ask(prompt, { json: true }), logger),
        tieBreaker: new LlmTieBreaker({ ask, logger }),
      };
    }
  }
}
