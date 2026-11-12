import { describe, expect, it } from "vitest";
import type { BatonEvent, BatonEventKind } from "../src/event.js";
import { renderChat } from "../src/handoff/chat.js";
import { buildHandoffDraft, type HandoffHeader } from "../src/handoff/packet.js";
import { HandoffKind } from "../src/handoff/schema.js";

let n = 0;
const ev = (kind: BatonEventKind, text: string, meta?: BatonEvent["meta"]): BatonEvent => ({
  id: `e${++n}`,
  agent: "claude-code",
  sessionId: "s-from",
  projectPath: "/work/shop",
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
    agent: "claude-code",
    repoId: "github.com/acme/shop",
    branch: "main",
  },
  to: {
    sessionId: "bbbbbbbb-0000-4000-8000-000000000002",
    agent: "codex",
    repoId: "github.com/acme/shop",
    branch: "main",
  },
  at: "2026-11-02T10:00:00.000Z",
};

describe("whole-chat handoff", () => {
  it("is a kind of handoff", () => {
    expect(HandoffKind.parse("chat")).toBe("chat");
  });

  it("labels Cursor replies and keeps unknown agents out of the event schema", () => {
    const cursorReply = { ...ev("reply", "Cursor finished."), agent: "cursor" as const };
    const md = renderChat(["# Chat from Ada", ""], [cursorReply]);
    expect(md).toContain("### Cursor");
  });

  it("renders the conversation in order from the compact view, without a model", () => {
    const events = [
      ev("session_start", ""),
      ev("prompt", "Add a cart total"),
      ev("thinking", "secret plan"),
      ev("tool_call", 'Read {"file_path":"src/cart.ts"}'),
      ev("tool_result", "export const cart = [];"),
      ev("tool_result", "ENOENT", { isError: true }),
      ev("reply", "Done: the total is in `src/cart.ts`."),
      ev("system", "<system-reminder>injected</system-reminder>"),
      ev("prompt", "subagent prompt", { sidechain: true }),
      ev("prompt", "Now test it"),
    ];
    const draft = buildHandoffDraft(events, header, { kind: "chat", filesTouched: [] });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(draft.kind).toBe("chat");
    expect(draft.summary).toBeUndefined();
    const md = draft.markdown;
    expect(md).toMatch(/^# Chat from Ada\n/);
    expect(md).toContain("github.com/acme/shop @ `main`");
    const order = [
      "Add a cart total",
      "src/cart.ts",
      "export const cart",
      "ENOENT",
      "Done: the total",
      "Now test it",
    ];
    const at = order.map((s) => md.indexOf(s));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(md).toContain("<summary>Tool error</summary>");
    expect(md).toContain("### Claude Code");
    // Thinking, injected system content and subagent work stay out.
    expect(md).not.toContain("secret plan");
    expect(md).not.toContain("injected");
    expect(md).not.toContain("subagent prompt");
  });

  it("drops the oldest turns to fit but keeps the first prompt", () => {
    const events = [ev("prompt", "THE GOAL")];
    for (let i = 0; i < 200; i++) events.push(ev("reply", `reply ${i} ${"x".repeat(500)}`));
    const md = renderChat(["# Chat from Ada", ""], events, 20_000);
    expect(md.length).toBeLessThanOrEqual(20_000);
    expect(md).toContain("THE GOAL");
    expect(md).toContain("reply 199 ");
    expect(md).not.toContain("reply 0 ");
    const left = /_… (\d+) earlier entries left out to fit\._/.exec(md);
    expect(left).not.toBeNull();
    const kept = (md.match(/### Claude Code/g) ?? []).length;
    expect(Number(left?.[1]) + kept).toBe(200);
    expect(md.indexOf("THE GOAL")).toBeLessThan(md.indexOf("earlier entries"));
  });

  it("says so when there is nothing to hand off, and never throws on odd text", () => {
    expect(renderChat(["# Chat from Ada", ""], [ev("session_start", "")])).toContain(
      "no messages yet",
    );
    const md = renderChat(
      ["# h", ""],
      [ev("tool_result", "```\nfenced\n```"), ev("tool_call", "a`b")],
    );
    expect(md).toContain("````\n```\nfenced");
    expect(md).toContain("`` a`b ``");
  });
});
