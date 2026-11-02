import type { BatonEvent } from "@baton/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionCard } from "../src/components/board/SessionCard.js";
import { isOutside, parseCardDrag } from "../src/lib/drag.js";
import { EventStore } from "../src/lib/event-store.js";
import {
  CARD_H,
  CARD_W,
  GRID,
  layout,
  loadPositions,
  place,
  savePositions,
  snap,
} from "../src/lib/positions.js";
import { Selection } from "../src/lib/selection.js";
import { summarize } from "../src/lib/summary.js";

const ev = (seq: number, kind: BatonEvent["kind"], text: string): BatonEvent => ({
  id: `e${seq}`,
  agent: "claude-code",
  sessionId: "s1",
  projectPath: "/work/app",
  ts: "2026-11-01T12:00:00.000Z",
  seq,
  kind,
  text,
});

describe("summarize", () => {
  it("takes the first prompt as the topic and the last reply as latest", () => {
    const s = summarize([
      ev(0, "prompt", "fix the   login bug"),
      ev(1, "tool_call", "Bash"),
      ev(2, "reply", "looking"),
      ev(3, "prompt", "also tests"),
      ev(4, "reply", "done"),
    ]);
    expect(s).toEqual({ topic: "fix the login bug", latest: "done", prompts: 2, toolCalls: 1 });
  });

  it("clips long text", () => {
    expect(summarize([ev(0, "prompt", "x".repeat(50))], 10).topic).toBe(`${"x".repeat(9)}…`);
  });

  it("handles an empty session", () => {
    expect(summarize([]).topic).toBeUndefined();
  });
});

describe("Selection.add", () => {
  it("adds once and respects the limit", () => {
    const sel = new Selection(undefined, 2);
    sel.add("a");
    sel.add("a");
    sel.add("b");
    sel.add("c");
    expect(sel.get()).toEqual(["a", "b"]);
  });
});

describe("SessionCard", () => {
  it("shows the owner and summary", () => {
    const html = renderToStaticMarkup(
      createElement(SessionCard, {
        store: new EventStore(),
        sessionId: "s1",
        info: {
          sessionId: "s1",
          agent: "claude-code",
          projectPath: "/work/app",
          projectName: "app",
          lastActivity: "2026-11-01T12:00:00.000Z",
          events: 0,
          source: "alice",
        },
        live: false,
        now: Date.parse("2026-11-01T12:00:05.000Z"),
        open: false,
        onOpen: () => {},
      }),
    );
    expect(html).toContain("alice");
    expect(html).toContain('aria-label="Claude Code"');
    expect(html).toContain("No prompts yet.");
    expect(html).toContain('aria-expanded="false"');
  });
});

describe("SessionCard agent", () => {
  it("falls back to the agent of the session's events before /sessions knows it", () => {
    const store = new EventStore();
    store.add({
      id: "x:start",
      agent: "codex",
      sessionId: "x",
      projectPath: "/work/x",
      ts: "2026-11-01T12:00:00.000Z",
      seq: 0,
      kind: "session_start",
      text: "/work/x",
    });
    const html = renderToStaticMarkup(
      createElement(SessionCard, {
        store,
        sessionId: "x",
        info: undefined,
        live: true,
        now: Date.parse("2026-11-01T12:00:05.000Z"),
        open: false,
        onOpen: () => {},
      }),
    );
    expect(html).toContain('aria-label="Codex"');
  });
});

describe("positions", () => {
  it("snaps to the grid and keeps cards on the board", () => {
    expect(snap({ x: 47, y: 50 })).toEqual({ x: 32, y: 64 });
    expect(snap({ x: -100, y: -5 })).toEqual({ x: 0, y: 0 });
  });

  it("keeps saved positions and fills free slots for new cards", () => {
    const placed = layout(["a", "b"], { a: { x: GRID, y: GRID } }, 3);
    expect(placed.a).toEqual({ x: GRID, y: GRID });
    expect(placed.b).toEqual({ x: GRID + CARD_W + GRID, y: GRID });
  });

  it("wraps to a new row when the board is narrow", () => {
    const placed = layout(["a", "b"], {}, 1);
    expect(placed.b).toEqual({ x: GRID, y: GRID + CARD_H + GRID });
  });

  it("round-trips through storage and ignores junk", () => {
    const map = new Map<string, string>();
    const storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    };
    savePositions(storage, { a: { x: 1, y: 2 } });
    expect(loadPositions(storage)).toEqual({ a: { x: 1, y: 2 } });
    map.set("baton.cardPositions", "{not json");
    expect(loadPositions(storage)).toEqual({});
  });
});

describe("place", () => {
  it("keeps the exact drop point, clamped to the board", () => {
    expect(place({ x: 47, y: 50 })).toEqual({ x: 47, y: 50 });
    expect(place({ x: -10, y: 5 })).toEqual({ x: 0, y: 5 });
  });
});

describe("drag helpers", () => {
  it("parses a card drag payload and rejects junk", () => {
    expect(parseCardDrag('{"id":"a","dx":3,"dy":4}')).toEqual({ id: "a", dx: 3, dy: 4 });
    expect(parseCardDrag("nope")).toBeUndefined();
    expect(parseCardDrag('{"id":""}')).toBeUndefined();
  });

  it("knows when a drop point is off the board", () => {
    const r = { left: 10, top: 10, right: 100, bottom: 100 };
    expect(isOutside({ x: 50, y: 50 }, r)).toBe(false);
    expect(isOutside({ x: 5, y: 50 }, r)).toBe(true);
    expect(isOutside({ x: 0, y: 0 }, r)).toBe(true);
  });
});
