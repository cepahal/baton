import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatHandoffBubble } from "../src/components/feed/ChatHandoffBubble.js";
import { Sidebar } from "../src/components/Sidebar.js";
import { HANDOFF_DRAG_TYPE, readHandoffDrag, setHandoffDrag } from "../src/lib/drag.js";

function transfer() {
  const data = new Map<string, string>();
  return {
    data,
    effectAllowed: "none" as DataTransfer["effectAllowed"],
    types: [] as string[],
    setData(type: string, value: string) {
      data.set(type, value);
      this.types = [...data.keys()];
    },
    getData: (type: string) => data.get(type) ?? "",
  };
}

describe("whole-chat handoff", () => {
  it("drags as a chat handoff of its session", () => {
    const t = transfer();
    setHandoffDrag(t, { kind: "chat", sessionId: "s1" });
    expect(t.data.get("text/plain")).toBe("Baton chat");
    expect(t.types).toContain(HANDOFF_DRAG_TYPE);
    expect(readHandoffDrag(t)).toEqual({ kind: "chat", sessionId: "s1" });
    // A chat drag needs its session.
    t.setData(HANDOFF_DRAG_TYPE, JSON.stringify({ kind: "chat", sessionId: "" }));
    expect(readHandoffDrag(t)).toBeUndefined();
  });

  it("renders a draggable bubble with the event count", () => {
    const html = renderToStaticMarkup(
      createElement(ChatHandoffBubble, { sessionId: "s1", events: 42 }),
    );
    expect(html).toContain('class="chat-bubble"');
    expect(html).toContain('draggable="true"');
    expect(html).toContain("Whole chat");
    expect(html).toContain("42 events");
  });
});

describe("brand", () => {
  it("shows the Baton wordmark", () => {
    const html = renderToStaticMarkup(
      createElement(Sidebar, {
        sessions: [],
        error: undefined,
        loaded: true,
        onCanvas: [],
        now: 0,
        connection: { status: "open", attempt: 0, gaps: 0 },
        onRetry: () => {},
      }),
    );
    expect(html).toMatch(/<img class="brand-logo" src="[^"]*baton-wordmark[^"]*" alt="Baton"/);
  });
});
