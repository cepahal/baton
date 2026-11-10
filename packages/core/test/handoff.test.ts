import { describe, expect, it } from "vitest";
import type { BatonEvent, BatonEventKind as EventKind } from "../src/event.js";
import {
  buildHandoffDraft,
  HANDOFF_GOAL_MAX,
  HANDOFF_SNIPPET_MAX_BYTES,
  type HandoffHeader,
  handoffCommand,
  handoffFilePath,
  handoffPrompt,
  heuristicSummary,
  renderHandoff,
  SUMMARIZER_INPUT_MAX_BYTES,
  shellFolder,
  summarizerInput,
} from "../src/handoff/packet.js";
import { HANDOFF_MARKDOWN_MAX, Handoff, HandoffCreate, HandoffId } from "../src/handoff/schema.js";
import { parseSession } from "../src/index.js";
import { CWD, jsonl, toolResult, toolUse, user } from "./helpers.js";

let n = 0;
const ev = (kind: EventKind, text: string, meta?: BatonEvent["meta"]): BatonEvent => ({
  id: `e${++n}`,
  agent: "claude-code",
  sessionId: "s-from",
  projectPath: CWD,
  ts: "2026-11-01T12:00:00.000Z",
  seq: n,
  kind,
  text,
  ...(meta ? { meta } : {}),
});

const header: HandoffHeader = {
  sender: "Ada",
  from: {
    sessionId: "aaaaaaaa-0000-4000-8000-000000000001",
    user: "ada",
    agent: "codex",
    repoId: "github.com/acme/shop",
    branch: "feat/cart",
  },
  to: {
    sessionId: "bbbbbbbb-0000-4000-8000-000000000002",
    user: "lin",
    agent: "claude-code",
    repoId: "github.com/acme/shop",
    branch: "main",
  },
  at: "2026-11-02T10:00:00.000Z",
};

const TEMPLATE_SECTIONS = [
  "## Goal",
  "## Current state",
  "## Decisions",
  "## Dead ends",
  "## Open questions",
  "## Files touched",
  "## Next steps",
];

describe("full handoff packet", () => {
  const events = [
    ev("prompt", "Add a cart page that lists items and totals them."),
    ev("reply", "Looking at the shop layout first."),
    ev("tool_call", "Write", {
      toolName: "Write",
      toolUseId: "t1",
      input: { file_path: `${CWD}/web/Cart.tsx`, content: "a\nb" },
    }),
    ev("tool_result", "npm test failed: Cannot find module './Cart'", { isError: true }),
    ev("thinking", "secret plan"),
    ev(
      "reply",
      "Cart renders. Totals still ignore discounts.\n- Should discounts apply before tax?",
    ),
  ];

  it("carries code metadata and a decline note, but never the patch itself", () => {
    const at = "2026-11-02T10:00:00.000Z";
    const h = Handoff.parse({
      id: "h0123456789",
      kind: "full",
      status: "declined",
      sender: "Ada",
      from: header.from,
      to: header.to,
      markdown: "# hi",
      code: { state: "attached", sha256: "a".repeat(64), files: ["a.ts"], patch: "diff --git" },
      note: "nope",
      createdAt: at,
      updatedAt: at,
    });
    expect(h.code).toEqual({ state: "attached", sha256: "a".repeat(64), files: ["a.ts"] });
    expect(h.note).toBe("nope");
    expect(() => Handoff.parse({ ...h, note: "x".repeat(501) })).toThrow();
  });

  it("fills every template section from the transcript, in order", () => {
    const files = [{ path: "web/Cart.tsx", ranges: [[1, 2]] as [number, number][] }];
    const draft = buildHandoffDraft(events, header, { kind: "full", filesTouched: files });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    const md = draft.markdown;
    const positions = TEMPLATE_SECTIONS.map((s) => md.indexOf(s));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(md).toContain("# Handoff from Ada");
    expect(md).toContain("github.com/acme/shop @ `feat/cart`");
    expect(md).toContain("Add a cart page");
    expect(md).toContain("Totals still ignore discounts");
    expect(md).toContain("Cannot find module './Cart'");
    expect(md).toContain("Should discounts apply before tax?");
    expect(md).toContain("`web/Cart.tsx` (lines 1–2)");
    expect(md).not.toContain("secret plan");
    expect(draft.summary?.filesTouched).toEqual(files);
  });

  it("caps the goal and leaves empty sections marked, not missing", () => {
    const s = heuristicSummary([ev("prompt", "x".repeat(5000))], []);
    expect(s.goal.length).toBeLessThanOrEqual(HANDOFF_GOAL_MAX + 1);
    const md = renderHandoff(header, s);
    for (const title of TEMPLATE_SECTIONS) expect(md).toContain(title);
    expect(md).toContain("_None._");
  });

  it("ignores sidechain (subagent) prompts and replies", () => {
    const s = heuristicSummary(
      [ev("prompt", "subagent task", { sidechain: true }), ev("prompt", "the real goal")],
      [],
    );
    expect(s.goal).toBe("the real goal");
  });

  it("builds from parsed transcripts too", () => {
    const { events } = parseSession(
      "claude-code",
      jsonl(
        user("Fix the login redirect"),
        toolUse("t1", "Edit", {
          file_path: `${CWD}/api/auth.ts`,
          old_string: "a",
          new_string: "b",
        }),
        toolResult("t1", "The file has been updated successfully."),
      ),
    );
    const draft = buildHandoffDraft(events, header, { kind: "full", filesTouched: [] });
    expect(draft.ok && draft.markdown).toContain("Fix the login redirect");
  });

  it("feeds the summarizer the compact view, newest events kept within budget", () => {
    const many = Array.from({ length: 400 }, (_, i) => ev("reply", `${i} ${"y".repeat(900)}`));
    const input = summarizerInput([ev("thinking", "hidden"), ...many]);
    expect(new TextEncoder().encode(input).length).toBeLessThanOrEqual(SUMMARIZER_INPUT_MAX_BYTES);
    expect(input).not.toContain("hidden");
    const lines = input.split("\n");
    expect(lines.at(-1)).toContain('"399 ');
    for (const line of lines) expect(JSON.parse(line)).toHaveProperty("kind", "reply");
  });
});

describe("snippet packet", () => {
  it("quotes the full tool output of the chosen event", () => {
    const big = "line\n".repeat(50);
    const e = ev("tool_result", "line (50 lines)", { full: big });
    const draft = buildHandoffDraft([ev("prompt", "p"), e], header, {
      kind: "snippet",
      eventId: e.id,
      filesTouched: [],
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(draft.kind).toBe("snippet");
    expect(draft.markdown).toContain("# Snippet from Ada");
    expect(draft.markdown.split("line").length - 1).toBeGreaterThanOrEqual(50);
    expect(draft.summary).toBeUndefined();
  });

  it("caps huge snippets and fails cleanly for unknown events", () => {
    const e = ev("reply", "z".repeat(HANDOFF_SNIPPET_MAX_BYTES * 3));
    const draft = buildHandoffDraft([e], header, {
      kind: "snippet",
      eventId: e.id,
      filesTouched: [],
    });
    expect(draft.ok && draft.markdown.length).toBeLessThan(HANDOFF_SNIPPET_MAX_BYTES + 2000);
    expect(
      buildHandoffDraft([e], header, { kind: "snippet", eventId: "nope", filesTouched: [] }).ok,
    ).toBe(false);
  });

  it("fences content that itself contains backtick fences", () => {
    const e = ev("reply", "before\n```\ncode\n```\nafter");
    const draft = buildHandoffDraft([e], header, {
      kind: "snippet",
      eventId: e.id,
      filesTouched: [],
    });
    expect(draft.ok && draft.markdown).toContain("````");
  });
});

describe("file paths and validation", () => {
  it("names the file and prompt from the id only", () => {
    expect(handoffFilePath("h0123456789")).toBe(".baton/handoffs/h0123456789.md");
    expect(handoffPrompt("h0123456789")).toMatch(/^[A-Za-z0-9 ./-]+$/);
    expect(HandoffId.safeParse("h0123456789").success).toBe(true);
    expect(HandoffId.safeParse("../../etc").success).toBe(false);
    expect(HandoffId.safeParse("h012345678;").success).toBe(false);
  });

  it("validates what senders submit", () => {
    const ok = HandoffCreate.safeParse({
      kind: "full",
      fromSessionId: "a",
      toSessionId: "b",
      markdown: "# hi",
      sender: "Ada",
    });
    expect(ok.success).toBe(true);
    expect(
      HandoffCreate.safeParse({
        kind: "full",
        fromSessionId: "a",
        toSessionId: "b",
        markdown: "x",
        sender: "",
      }).success,
    ).toBe(false);
    expect(
      HandoffCreate.safeParse({
        kind: "full",
        fromSessionId: "a",
        toSessionId: "b",
        markdown: "x".repeat(HANDOFF_MARKDOWN_MAX + 1),
        sender: "A",
      }).success,
    ).toBe(false);
    expect(Handoff.safeParse({}).success).toBe(false);
  });
});

describe("the command a receiver runs", () => {
  it("leaves plain folders alone", () => {
    expect(shellFolder("/work/shop")).toBe("/work/shop");
    expect(shellFolder(String.raw`C:\work\shop`)).toBe(String.raw`C:\work\shop`);
  });

  it("quotes a Windows folder without escaping, and never ends it in a backslash", () => {
    expect(shellFolder(String.raw`C:\My Repo\ `.trim())).toBe(String.raw`"C:\My Repo"`);
    expect(shellFolder(String.raw`C:\My Repo`)).toBe(String.raw`"C:\My Repo"`);
    expect(shellFolder(String.raw`\\server\team share\ `.trim())).toBe(
      String.raw`"\\server\team share"`,
    );
    expect(handoffCommand("claude-code", String.raw`C:\My Repo\ `.trim(), "go")).toBe(
      String.raw`cd "C:\My Repo" && claude "go"`,
    );
  });

  it("escapes everything sh would interpret in a POSIX folder", () => {
    expect(shellFolder("/tmp/my repo")).toBe('"/tmp/my repo"');
    const bs = "\\";
    const bt = "`";
    const folder = `/tmp/a "b" $HOME ${bt}id${bt} c${bs}`;
    expect(shellFolder(folder)).toBe(
      `"/tmp/a ${bs}"b${bs}" ${bs}$HOME ${bs}${bt}id${bs}${bt} c${bs}${bs}"`,
    );
  });
});
