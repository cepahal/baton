import { describe, expect, it, vi } from "vitest";
import {
  COMPACT_TEXT_MAX_BYTES,
  compactForLLM,
  createTranscriptParser,
  cutChars,
  keepChars,
  ONE_LINE_MAX,
  parseTranscript,
  truncateBytes,
  utf8Length,
} from "../src/index.js";
import { assistant, base, FIXTURES, readFixture, toolResult, toolUse, user } from "./helpers.js";

describe("malformed lines", () => {
  it.each([
    ["invalid JSON", "{oops"],
    ["a JSON number", "42"],
    ["a JSON array", "[1,2]"],
    ["JSON null", "null"],
    ["a record without a type", JSON.stringify({ uuid: "u" })],
    ["a user record without a message", JSON.stringify({ ...base(), type: "user" })],
    [
      "a user record with a bad timestamp",
      JSON.stringify({ ...base(), type: "user", timestamp: "noon", message: { content: "x" } }),
    ],
    [
      "an assistant record with non-array content",
      JSON.stringify({ ...base(), type: "assistant", message: { content: "x" } }),
    ],
  ])("returns [] and warns for %s", (_, line) => {
    const onWarning = vi.fn();
    expect(createTranscriptParser({ onWarning }).parseLine(line)).toEqual([]);
    expect(onWarning).toHaveBeenCalledOnce();
  });

  it("ignores blank lines without warning", () => {
    const onWarning = vi.fn();
    const p = createTranscriptParser({ onWarning });
    expect([...p.parseLine(""), ...p.parseLine("   \r")]).toEqual([]);
    expect(onWarning).not.toHaveBeenCalled();
  });

  it("works without any options", () => {
    expect(createTranscriptParser().parseLine("{oops")).toEqual([]);
  });

  it("skips one bad content block but keeps the rest of the record", () => {
    const { events, warnings } = parseTranscript(
      assistant([
        { type: "tool_use", id: 7 },
        { type: "text", text: 99 },
        { type: "mystery_block" },
        { type: "text", text: "still here" },
      ]),
    );
    expect(warnings).toEqual([]);
    expect(events.slice(1).map((e) => e.text)).toEqual(["still here"]);
  });
});

describe("partial lines", () => {
  it("returns [] for a half-written line, then parses it once complete", () => {
    const line = user("hello there");
    const p = createTranscriptParser();
    expect(p.parseLine(line.slice(0, line.length / 2))).toEqual([]);
    expect(p.parseLine(line).map((e) => e.kind)).toEqual(["session_start", "prompt"]);
  });

  it.each(FIXTURES)("never throws on any prefix of any line in %s", (name) => {
    const p = createTranscriptParser();
    for (const line of readFixture(name).split("\n")) {
      for (const cut of [1, 0.25, 0.5, 0.9].map((f) => Math.floor(line.length * f))) {
        expect(() => p.parseLine(line.slice(0, cut))).not.toThrow();
      }
    }
  });
});

describe("unknown record types", () => {
  const rec = (type: string) => JSON.stringify({ ...base(), type });

  it("drops them without a warning", () => {
    const onWarning = vi.fn();
    expect(createTranscriptParser({ onWarning }).parseLine(rec("brand-new-type"))).toEqual([]);
    expect(onWarning).not.toHaveBeenCalled();
  });

  it("reports them only in debug mode", () => {
    const debug = vi.fn();
    const p = createTranscriptParser({ debug });
    p.parseLine(rec("brand-new-type"));
    expect(debug).toHaveBeenCalledWith('line 1: dropped unknown record type "brand-new-type"');
  });

  it.each(["attachment", "api-request", "queue-operation", "cost-state", "file-history-snapshot"])(
    "drops %s quietly, even in debug mode",
    (type) => {
      const debug = vi.fn();
      expect(createTranscriptParser({ debug }).parseLine(rec(type))).toEqual([]);
      expect(debug).not.toHaveBeenCalled();
    },
  );

  it("passes debug through parseTranscript", () => {
    const debug = vi.fn();
    parseTranscript(rec("brand-new-type"), { debug });
    expect(debug).toHaveBeenCalledOnce();
  });

  it("accepts records with fields it doesn't know (lenient input)", () => {
    const line = JSON.stringify({
      ...base(),
      type: "user",
      newField: { anything: true },
      message: { role: "user", content: "hi", extra: 1 },
    });
    expect(parseTranscript(line).events.map((e) => e.kind)).toEqual(["session_start", "prompt"]);
  });
});

describe("huge tool outputs", () => {
  const big = Array.from({ length: 50_000 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
  const { events } = parseTranscript(
    [toolUse("t1", "Bash", { command: "cat big.log" }), toolResult("t1", big)].join("\n"),
  );
  const result = events.find((e) => e.kind === "tool_result");

  it("summarizes to one short line and keeps the whole output in meta.full", () => {
    expect(result?.text).toBe("Bash → exit 0, 50000 lines");
    expect(result?.meta?.full).toBe(big);
    expect(result?.meta?.lines).toBe(50_000);
  });

  it("drops the output from the handoff", () => {
    const compact = compactForLLM(events);
    expect(JSON.stringify(compact).length).toBeLessThan(2_000);
  });

  it("caps any huge text field in the handoff at 4 KB with a marker", () => {
    const prompt = parseTranscript(user(big)).events;
    const [, cut] = compactForLLM(prompt);
    expect(utf8Length(cut?.text ?? "")).toBeLessThan(COMPACT_TEXT_MAX_BYTES + 50);
    expect(cut?.text).toMatch(/… \[truncated, \d+ bytes total\]$/);
    expect(cut?.text.startsWith("line 0 ")).toBe(true);
  });
});

describe("unicode", () => {
  const emoji = "👩‍💻"; // 3 code points, 5 UTF-16 units, 11 UTF-8 bytes

  it("keeps non-ASCII text intact through parsing", () => {
    const text = "修复构建 ✅ — émoji 🎉, RTL שלום, combining é";
    const { events } = parseTranscript(
      [
        user(text),
        assistant([{ type: "text", text }]),
        toolUse("t1", "Bash", { command: "echo 🎉" }),
      ].join("\n"),
    );
    expect(events.slice(1).map((e) => e.text)).toEqual([text, text, "Bash echo 🎉"]);
  });

  it("counts UTF-8 bytes", () => {
    expect(utf8Length("a")).toBe(1);
    expect(utf8Length("é")).toBe(2);
    expect(utf8Length("修")).toBe(3);
    expect(utf8Length("🎉")).toBe(4);
    expect(utf8Length(emoji)).toBe(11);
  });

  it("never cuts inside a surrogate pair", () => {
    const s = "🎉".repeat(200);
    for (const max of [1, 2, 7, 120]) {
      const out = cutChars(s, max);
      expect([...out]).toHaveLength(max);
      expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    }
    expect(keepChars(s, 3)).toBe("🎉🎉🎉…");
    expect(keepChars("🎉🎉", 3)).toBe("🎉🎉");
  });

  it("cuts by bytes on code point boundaries", () => {
    const s = "🎉".repeat(2000); // 8000 bytes
    const out = truncateBytes(s, 4097);
    expect(out.startsWith("🎉".repeat(1024))).toBe(true);
    expect(out).toBe(`${"🎉".repeat(1024)}… [truncated, 8000 bytes total]`);
    expect(truncateBytes("修".repeat(1366), 4096)).toMatch(
      /^修{1365}… \[truncated, 4098 bytes total\]$/,
    );
    expect(truncateBytes("short", 4096)).toBe("short");
    expect(truncateBytes("é".repeat(2048), 4096)).toBe("é".repeat(2048));
  });

  it("keeps one-line summaries within the limit in code points", () => {
    const { events } = parseTranscript(
      [toolUse("t1", "Grep", { pattern: "🎉".repeat(300) }), toolResult("t1", "a")].join("\n"),
    );
    for (const e of events.slice(1)) expect([...e.text].length).toBeLessThanOrEqual(ONE_LINE_MAX);
  });
});

describe("filter rule edge cases", () => {
  const texts = (text: string) => parseTranscript(text).events.map((e) => [e.kind, e.text]);

  it("drops empty isMeta / compact-summary text and empty assistant text", () => {
    expect(
      texts(
        [
          user("  ", { isMeta: true }),
          user("", { isCompactSummary: true }),
          assistant([{ type: "text", text: "\n " }]),
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("labels a system record without a subtype as source system", () => {
    const rec = JSON.stringify({ ...base(), type: "system", content: "Heads up" });
    expect(parseTranscript(rec).events[1]?.meta).toEqual({ source: "system" });
  });

  it("uses an empty projectPath until a record has a cwd, then follows cwd", () => {
    const { cwd: _, ...noCwd } = base();
    const rec = (uuid: string, cwd: object) =>
      JSON.stringify({ ...noCwd, ...cwd, uuid, type: "user", message: { content: "x" } });
    const { events } = parseTranscript([rec("a", {}), rec("b", { cwd: "/b" })].join("\n"));
    expect(events.map((e) => e.projectPath)).toEqual(["", "", "/b"]);
  });

  it("omits meta when an event has none", () => {
    const line = JSON.stringify({
      ...base(),
      type: "assistant",
      message: { content: [{ type: "text", text: "hi" }] },
    });
    expect(parseTranscript(line).events[1]).not.toHaveProperty("meta");
  });

  it("compacts events that carry no meta", () => {
    const { events } = parseTranscript(
      [toolUse("t1", "Bash", {}), toolResult("t1", "ok")].join("\n"),
    );
    const bare = events.map(({ meta: _, ...e }) => e);
    expect(compactForLLM(bare).map((e) => e.kind)).toEqual([
      "session_start",
      "tool_call",
      "tool_result",
    ]);
  });
});
