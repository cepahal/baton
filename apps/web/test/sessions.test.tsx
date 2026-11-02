import type { SessionInfo } from "@baton/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Sidebar } from "../src/components/Sidebar.js";
import { groupBySource } from "../src/lib/session-groups.js";

const session = (sessionId: string, source?: string): SessionInfo => ({
  sessionId,
  projectPath: `/work/${sessionId}`,
  projectName: sessionId,
  lastActivity: "2026-11-01T12:00:00.000Z",
  events: 3,
  ...(source === undefined ? {} : { source }),
});

describe("groupBySource", () => {
  it("groups by daemon, keeping the most recent first in and between groups", () => {
    const groups = groupBySource([
      session("a1", "alice"),
      session("b1", "bob"),
      session("a2", "alice"),
    ]);
    expect(groups.map((g) => [g.source, g.sessions.map((s) => s.sessionId)])).toEqual([
      ["alice", ["a1", "a2"]],
      ["bob", ["b1"]],
    ]);
  });

  it("returns one unnamed group for a local daemon", () => {
    const groups = groupBySource([session("x"), session("y")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.source).toBeUndefined();
  });
});

describe("Sidebar", () => {
  const render = (sessions: SessionInfo[]) =>
    renderToStaticMarkup(
      createElement(Sidebar, {
        sessions,
        error: undefined,
        loaded: true,
        selected: [],
        maxSelected: 3,
        now: Date.parse("2026-11-01T12:00:05.000Z"),
        connection: { status: "open", attempt: 0, gaps: 0 },
        onRetry: () => {},
        onToggle: () => {},
      }),
    );

  it("heads each daemon's sessions with its name on a team server", () => {
    const html = render([session("a1", "alice"), session("b1", "bob")]);
    expect(html).toContain('class="session-group-name">alice<');
    expect(html).toContain('class="session-group-name">bob<');
  });

  it("shows no group headings for a local daemon", () => {
    expect(render([session("a1")])).not.toContain("session-group-heading");
  });
});
