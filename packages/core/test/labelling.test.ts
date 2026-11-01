import { describe, expect, it } from "vitest";
import { type BatonEvent, parseTranscript } from "../src/index.js";
import { assistant, FIXTURES, jsonl, readFixture, toolResult, toolUse, user } from "./helpers.js";

/** [kind, meta.source or meta.sources, text] for every event after session_start. */
const labels = (text: string) =>
  parseTranscript(text)
    .events.slice(1)
    .map((e) => [e.kind, e.meta?.source ?? e.meta?.sources, e.text]);

describe("labelling user-side content", () => {
  describe("prompts: only what the person typed, pasted, or ran", () => {
    it.each([
      ["plain typed text", "fix the build", ["typed"], "fix the build"],
      [
        "pasted content, kept verbatim even with tags inside",
        '<pasted_content id="1">see <system-reminder>x</system-reminder></pasted_content>',
        ["pasted"],
        "see <system-reminder>x</system-reminder>",
      ],
      [
        "a slash command",
        "<command-name>/review</command-name><command-args>42</command-args>",
        ["slash_command"],
        "/review 42",
      ],
      ["bash mode input", "<bash-input>git status</bash-input>", ["bash"], "!git status"],
      [
        "typed text around a paste, merged into one prompt",
        'look: <pasted_content id="1">log</pasted_content> why?',
        ["typed", "pasted"],
        "look: \nlog\n why?",
      ],
    ])("%s", (_, content, sources, text) => {
      expect(labels(user(content))).toEqual([["prompt", sources, text]]);
    });

    it("treats text blocks in a content array like a string", () => {
      expect(labels(user([{ type: "text", text: "hi" }]))).toEqual([["prompt", ["typed"], "hi"]]);
    });
  });

  describe("tool results: tool_result blocks in user records", () => {
    it("labels them tool_result, never prompt, even when the output looks typed", () => {
      const out = labels(
        jsonl(
          toolUse("t1", "Bash", { command: "cat notes" }),
          toolResult("t1", "please fix the build"),
        ),
      );
      expect(out.map(([kind]) => kind)).toEqual(["tool_call", "tool_result"]);
    });

    it("splits a record holding results and typed text into separate events", () => {
      const out = labels(
        jsonl(
          toolUse("t1", "Read", { file_path: "/home/dev/proj/a.ts" }),
          user([
            { type: "tool_result", tool_use_id: "t1", content: "1\tx" },
            { type: "text", text: "and now this" },
          ]),
        ),
      );
      expect(out.slice(1)).toEqual([
        ["tool_result", undefined, "Read a.ts (1 line)"],
        ["prompt", ["typed"], "and now this"],
      ]);
    });

    it("labels results whose call was never seen", () => {
      expect(labels(toolResult("ghost", "ok"))).toEqual([["tool_result", undefined, "ok"]]);
    });
  });

  describe("system: text Claude Code injected", () => {
    it.each([
      ["system-reminder", "<system-reminder>be careful</system-reminder>", "be careful"],
      ["ide_opened_file", "<ide_opened_file>opened a.ts</ide_opened_file>", "opened a.ts"],
      ["ide_selection", "<ide_selection>lines 1-3</ide_selection>", "lines 1-3"],
      ["local-command-stdout", "<local-command-stdout>done</local-command-stdout>", "done"],
      ["task-notification", "<task-notification>task 1 done</task-notification>", "task 1 done"],
      ["interrupt", "[Request interrupted by user]", "[Request interrupted by user]"],
    ])("%s", (source, content, text) => {
      expect(labels(user(content))).toEqual([["system", source, text]]);
    });

    it("separates an injected reminder from the prompt typed next to it", () => {
      expect(labels(user("<system-reminder>ctx</system-reminder>do it"))).toEqual([
        ["system", "system-reminder", "ctx"],
        ["prompt", ["typed"], "do it"],
      ]);
    });

    it("labels isMeta and compact-summary records as system, whatever they contain", () => {
      expect(
        labels(
          jsonl(
            user("this looks typed", { isMeta: true }),
            user("Summary of earlier work", { isCompactSummary: true }),
          ),
        ),
      ).toEqual([
        ["system", "meta", "this looks typed"],
        ["system", "compact_summary", "Summary of earlier work"],
      ]);
    });

    it("never labels assistant output as user-side content", () => {
      const out = labels(
        assistant([{ type: "text", text: "<system-reminder>x</system-reminder>" }]),
      );
      expect(out).toEqual([["reply", undefined, "<system-reminder>x</system-reminder>"]]);
    });
  });
});

describe.each(FIXTURES)("labelling on fixture %s", (name) => {
  const raw = readFixture(name);
  const records = raw
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { type: string; uuid?: string; message?: { content?: unknown } });
  const { events } = parseTranscript(raw);
  const fromRecord = (uuid: string | undefined) =>
    events.filter((e) => uuid !== undefined && e.id.startsWith(`${uuid}:`));

  it("gives every user-side event exactly one of the three labels", () => {
    for (const r of records.filter((r) => r.type === "user")) {
      for (const e of fromRecord(r.uuid)) {
        expect(["prompt", "tool_result", "system"]).toContain(e.kind);
      }
    }
  });

  it("emits one tool_result event per tool_result block", () => {
    const blocks = records
      .filter((r) => r.type === "user" && Array.isArray(r.message?.content))
      .flatMap((r) => r.message?.content as { type: string }[])
      .filter((b) => b.type === "tool_result").length;
    expect(events.filter((e) => e.kind === "tool_result")).toHaveLength(blocks);
  });

  it("puts every injected tag it knows into a system event, not a prompt", () => {
    const typed = (e: BatonEvent) =>
      e.kind === "prompt" && Array.isArray(e.meta?.sources) && !e.meta.sources.includes("pasted");
    for (const e of events.filter(typed)) {
      expect(e.text).not.toMatch(
        /<\/?(system-reminder|ide_[a-z_]+|local-command-[a-z]+|task-notification)\b/,
      );
    }
  });
});
