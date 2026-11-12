import type { SessionInfo } from "@baton/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Sidebar } from "../src/components/Sidebar.js";
import { groupBySource } from "../src/lib/session-groups.js";

const session = (
  sessionId: string,
  source?: string,
  agent: SessionInfo["agent"] = "claude-code",
): SessionInfo => ({
  sessionId,
  agent,
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
        onCanvas: ["c1"],
        now: Date.parse("2026-11-01T12:00:05.000Z"),
        connection: { status: "open", attempt: 0, gaps: 0 },
        onRetry: () => {},
      }),
    );

  it("heads each daemon's sessions with its name on a team server", () => {
    const html = render([session("a1", "alice"), session("b1", "bob")]);
    expect(html).toContain('class="session-group-name">alice<');
    expect(html).toContain('class="session-group-name">bob<');
  });

  it("marks each session with its agent's icon", () => {
    const html = render([
      session("c1"),
      session("x1", undefined, "codex"),
      session("u1", undefined, "cursor"),
    ]);
    expect(html).toContain(
      'class="agent-icon agent-claude-code" role="img" aria-label="Claude Code"',
    );
    expect(html).toContain('class="agent-icon agent-codex" role="img" aria-label="Codex"');
    expect(html).toContain('class="agent-icon agent-cursor" role="img" aria-label="Cursor"');
  });

  it("lets sessions be dragged but not clicked onto the canvas", () => {
    const html = render([session("c1"), session("d1")]);
    expect(html.match(/draggable="true"/g)).toHaveLength(2);
    expect(html).not.toContain("<button");
    expect(html).toContain('class="session is-selected"');
  });

  it("shows no group headings for a local daemon", () => {
    expect(render([session("a1")])).not.toContain("session-group-heading");
  });
});
