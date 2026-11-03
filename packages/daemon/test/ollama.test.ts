import { describe, expect, it } from "vitest";
import {
  OLLAMA_RETRY_MS,
  Ollama,
  type OllamaModel,
  parameterBillions,
  pickFastestModel,
} from "../src/ollama.js";
import { modelSummarizer } from "../src/summarizer.js";
import { silent } from "./helpers.js";

const m = (
  name: string,
  parameter_size?: string,
  extra: Partial<OllamaModel> = {},
): OllamaModel => ({
  name,
  ...(parameter_size ? { details: { parameter_size } } : {}),
  ...extra,
});

describe("picking the summarizer model", () => {
  it("reads Ollama's parameter labels", () => {
    expect(parameterBillions("1.9B")).toBe(1.9);
    expect(parameterBillions("270M")).toBeCloseTo(0.27);
    expect(parameterBillions("12B")).toBe(12);
    expect(parameterBillions("big")).toBeUndefined();
    expect(parameterBillions(undefined)).toBeUndefined();
  });

  it("chooses the fewest parameters, skipping embedding models", () => {
    const models = [
      m("gemma4:12b", "12B"),
      m("nomic-embed-text:latest", "137M"),
      m("qwen3.5:2b", "1.9B"),
      m("llama3.2:3b", "3.2B"),
    ];
    expect(pickFastestModel(models)?.name).toBe("qwen3.5:2b");
  });

  it("trusts capabilities when Ollama reports them", () => {
    const models = [
      m("tiny-embed", "100M", { capabilities: ["embedding"] }),
      m("small", "1B", { capabilities: ["completion"] }),
    ];
    expect(pickFastestModel(models)?.name).toBe("small");
  });

  it("breaks ties by size, then name; unknown sizes go last", () => {
    expect(
      pickFastestModel([m("b", "1B", { size: 10 }), m("a", "1B", { size: 10 }), m("c", undefined)])
        ?.name,
    ).toBe("a");
    expect(pickFastestModel([m("x", undefined, { size: 5 }), m("y", "7B")])?.name).toBe("y");
    expect(pickFastestModel([])).toBeUndefined();
  });
});

type Call = { url: string; body?: Record<string, unknown> };

function fakeOllama(handler: (call: Call) => { status?: number; body: unknown } | Error) {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}),
    };
    calls.push(call);
    const out = handler(call);
    if (out instanceof Error) throw out;
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200 });
  }) as typeof fetch;
  return { calls, fetchFn };
}

const TAGS = {
  models: [
    { name: "gemma4:12b", size: 8e9, details: { parameter_size: "12B" } },
    {
      name: "qwen3.5:2b",
      size: 2e9,
      details: { parameter_size: "1.9B" },
      capabilities: ["completion", "thinking"],
    },
  ],
};

describe("Ollama client", () => {
  it("asks the fastest model, without thinking, as JSON when asked", async () => {
    const { calls, fetchFn } = fakeOllama((c) =>
      c.url.endsWith("/api/tags") ? { body: TAGS } : { body: { message: { content: "{}" } } },
    );
    const ollama = new Ollama({ url: "http://ollama:1/", logger: silent, fetch: fetchFn });
    expect(await ollama.ask("hi", { json: true })).toBe("{}");
    expect(await ollama.ask("again")).toBe("{}");
    const chats = calls.filter((c) => c.url === "http://ollama:1/api/chat");
    expect(chats).toHaveLength(2);
    expect(chats[0]?.body).toMatchObject({
      model: "qwen3.5:2b",
      stream: false,
      think: false,
      format: "json",
    });
    expect(chats[1]?.body).not.toHaveProperty("format");
    // The model list is fetched once.
    expect(calls.filter((c) => c.url.endsWith("/api/tags"))).toHaveLength(1);
  });

  it("uses the configured model without listing", async () => {
    const { calls, fetchFn } = fakeOllama(() => ({ body: { message: { content: "ok" } } }));
    const ollama = new Ollama({
      url: "http://o",
      model: "mine:1b",
      logger: silent,
      fetch: fetchFn,
    });
    expect(await ollama.ask("x")).toBe("ok");
    expect(calls.map((c) => c.url)).toEqual(["http://o/api/chat"]);
    expect(calls[0]?.body?.model).toBe("mine:1b");
  });

  it("returns undefined when Ollama is down, and retries after a pause", async () => {
    let up = false;
    let clock = 0;
    const { calls, fetchFn } = fakeOllama((c) => {
      if (!up) return new Error("ECONNREFUSED");
      return c.url.endsWith("/api/tags")
        ? { body: TAGS }
        : { body: { message: { content: "yes" } } };
    });
    const ollama = new Ollama({
      url: "http://o",
      logger: silent,
      fetch: fetchFn,
      now: () => clock,
    });
    expect(await ollama.ask("x")).toBeUndefined();
    up = true;
    // Within the pause: no new lookup.
    expect(await ollama.ask("x")).toBeUndefined();
    expect(calls).toHaveLength(1);
    clock += OLLAMA_RETRY_MS + 1;
    expect(await ollama.ask("x")).toBe("yes");
  });

  it("returns undefined when no text model is installed", async () => {
    const { fetchFn } = fakeOllama(() => ({
      body: { models: [{ name: "nomic-embed-text", details: { family: "nomic-bert" } }] },
    }));
    const ollama = new Ollama({ url: "http://o", logger: silent, fetch: fetchFn });
    expect(await ollama.model()).toBeUndefined();
    expect(await ollama.ask("x")).toBeUndefined();
  });

  it("returns undefined on an error reply instead of throwing", async () => {
    const { fetchFn } = fakeOllama((c) =>
      c.url.endsWith("/api/tags") ? { body: TAGS } : { status: 500, body: { error: "boom" } },
    );
    const ollama = new Ollama({ url: "http://o", logger: silent, fetch: fetchFn });
    expect(await ollama.ask("x")).toBeUndefined();
  });

  it("sends one request at a time", async () => {
    let inFlight = 0;
    let most = 0;
    const fetchFn = (async (input: string | URL | Request) => {
      if (String(input).endsWith("/api/tags")) return new Response(JSON.stringify(TAGS));
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return new Response(JSON.stringify({ message: { content: "ok" } }));
    }) as typeof fetch;
    const ollama = new Ollama({ url: "http://o", logger: silent, fetch: fetchFn });
    await Promise.all([ollama.ask("1"), ollama.ask("2"), ollama.ask("3")]);
    expect(most).toBe(1);
  });
});

describe("model summarizer", () => {
  it("validates the model's JSON and rejects junk", async () => {
    const good = {
      goal: "g",
      currentState: "s",
      decisions: ["d"],
      deadEnds: [],
      openQuestions: [],
      nextSteps: ["n"],
    };
    const ok = modelSummarizer(async () => JSON.stringify(good), silent);
    expect(await ok("{}")).toMatchObject({ goal: "g", nextSteps: ["n"] });
    const junk = modelSummarizer(async () => "not json at all", silent);
    expect(await junk("{}")).toBeUndefined();
    const down = modelSummarizer(async () => undefined, silent);
    expect(await down("{}")).toBeUndefined();
  });
});
