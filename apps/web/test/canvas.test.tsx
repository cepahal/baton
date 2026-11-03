import type { CanvasPositions, SessionInfo } from "@baton/core";
import { type Node, ReactFlowProvider } from "@xyflow/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  cardsMoved,
  LINK_COLORS,
  mergeNodes,
  toEdge,
  toNodes,
} from "../src/components/canvas/Canvas.js";
import { DomainChip } from "../src/components/canvas/DomainChip.js";
import { floatingLine } from "../src/components/canvas/LinkEdge.js";
import { SessionNode } from "../src/components/canvas/SessionNode.js";
import { applyCanvasMessage } from "../src/hooks/useCanvasPositions.js";
import {
  buildCanvas,
  CARD_H,
  CARD_W,
  cardDomain,
  compareFiles,
  dedupe,
  flowBetween,
  GROUP_HEAD,
  GROUP_PAD,
  groupTitle,
  placeDrop,
  rangesOverlap,
  SPAWN_DISTANCE,
} from "../src/lib/canvas-model.js";

const NOW = Date.parse("2026-11-02T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const session = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
  sessionId: id,
  agent: "claude-code",
  projectPath: "/work/app",
  projectName: "app",
  lastActivity: ago(60_000),
  events: 10,
  ...over,
});

const inRepo = (repoId: string | null, branch: string | null, relativeCwd = "") => ({
  repo: { repoId, branch, relativeCwd },
});

type Ranges = [number, number][];

describe("buildCanvas", () => {
  const front = session("front", {
    ...inRepo("github.com/acme/shop", "feat/cart", "web"),
    domain: { label: "frontend", confidence: 0.8, reasons: [], source: "rules" },
    files: [{ path: "web/src/Cart.tsx", ranges: [[1, 40]] }],
  });
  const back = session("back", {
    ...inRepo("github.com/acme/shop", "main", "api"),
    projectPath: "/work/app/api",
    domain: { label: "backend", confidence: 0.7, reasons: [], source: "rules" },
    files: [{ path: "api/server.ts", ranges: [] }],
  });
  const docs = session("docs", inRepo("github.com/acme/shop", "docs"));
  const other = session("other", {
    ...inRepo("github.com/acme/infra", "main"),
    projectPath: "/work/infra",
  });
  const at = (...ids: string[]): CanvasPositions =>
    Object.fromEntries(ids.map((id, i) => [`session:${id}`, { x: 100 + 400 * i, y: 200 }]));

  it("shows only sessions that were put on the canvas", () => {
    expect(buildCanvas([front, back, other], {}).groups).toEqual([]);
    const m = buildCanvas([front, back, other], at("front", "other"));
    expect(m.groups.map((g) => [g.title, g.cards.map((c) => c.session.sessionId)])).toEqual([
      ["shop", ["front"]],
      ["infra", ["other"]],
    ]);
  });

  it("draws each repo's box around its cards, where they were put", () => {
    const m = buildCanvas([front, back], {
      "session:front": { x: 100, y: 200 },
      "session:back": { x: 600, y: 500 },
    });
    const g = m.groups[0];
    expect(g?.cards.map((c) => c.position)).toEqual([
      { x: 600, y: 500 },
      { x: 100, y: 200 },
    ]);
    expect(g?.position).toEqual({ x: 100 - GROUP_PAD, y: 200 - GROUP_HEAD });
    expect(g?.width).toBe(500 + CARD_W + 2 * GROUP_PAD);
    expect(g?.height).toBe(300 + CARD_H + GROUP_PAD + GROUP_HEAD);
  });

  it("links every pair in a repo, idle or not, with an arrow along a flow", () => {
    const idle = { ...back, lastActivity: "2020-01-01T00:00:00.000Z" };
    const m = buildCanvas([idle, docs, front, other], at("front", "back", "docs", "other"));
    expect(m.links.map((l) => [l.source, l.target, l.directed, l.label])).toEqual([
      ["session:back", "session:docs", false, "main ↔ docs · 0 shared files"],
      ["session:front", "session:back", true, "feat/cart → main · 0 shared files"],
      ["session:docs", "session:front", false, "docs ↔ feat/cart · 0 shared files"],
    ]);
  });

  it("puts a session on the canvas once, however often it is listed", () => {
    const stale = { ...front, lastActivity: ago(3_600_000), events: 1 };
    const m = buildCanvas([stale, front, front], at("front"));
    expect(m.groups).toHaveLength(1);
    expect(m.groups[0]?.cards.map((c) => c.session.events)).toEqual([10]);
    expect(dedupe([stale, front])).toEqual([front]);
  });

  it("marks shared files and overlapping lines", () => {
    const near: Ranges = [[80, 90]];
    const touching = { ...back, files: [{ path: "web/src/Cart.tsx", ranges: near }] };
    expect(buildCanvas([front, touching], at("front", "back")).links[0]).toMatchObject({
      level: "file",
      shared: ["web/src/Cart.tsx"],
      label: "feat/cart → main · 1 shared file",
    });
    const over: Ranges = [[30, 50]];
    const clashing = { ...back, files: [{ path: "web/src/Cart.tsx", ranges: over }] };
    expect(buildCanvas([front, clashing], at("front", "back")).links[0]?.level).toBe("lines");
  });

  it("groups sessions outside git by folder", () => {
    const loose = session("loose", { ...inRepo(null, null), projectPath: "C:\\notes\\jobs" });
    const plain = session("plain", { projectPath: "/tmp/x" });
    const m = buildCanvas([loose, plain], at("loose", "plain"));
    expect(m.groups.map((g) => [g.key, g.title])).toEqual([
      ["repo:dir:C:\\notes\\jobs", "jobs"],
      ["repo:dir:/tmp/x", "x"],
    ]);
  });
});

describe("flowBetween", () => {
  it("knows which way work flows, and when it doesn't", () => {
    expect(flowBetween("frontend", "backend")).toBe("forward");
    expect(flowBetween("backend", "frontend")).toBe("backward");
    expect(flowBetween("data", "ml")).toBe("forward");
    expect(flowBetween("frontend", "infra")).toBeUndefined();
    expect(flowBetween("frontend", "frontend")).toBeUndefined();
    expect(flowBetween(undefined, "backend")).toBeUndefined();
  });
});

describe("placeDrop", () => {
  const a = session("a", inRepo("github.com/acme/shop", "main"));
  const b = session("b", inRepo("github.com/acme/shop", "dev"));
  const c = session("c", inRepo("github.com/acme/other", "main"));
  const fixed = (...values: number[]) => {
    let i = 0;
    return () => values[i++ % values.length] ?? 0;
  };

  it("centres a card where it's dropped when its repo isn't on the canvas", () => {
    const model = buildCanvas([a, c], { "session:c": { x: 0, y: 0 } });
    expect(placeDrop(a, { x: 1000, y: 700 }, model, fixed(0.3))).toEqual({
      x: 1000 - CARD_W / 2,
      y: 700 - CARD_H / 2,
    });
  });

  it("puts a card two card widths from its repo's nearest card, in a random direction", () => {
    const model = buildCanvas([a, b], {
      "session:a": { x: 0, y: 0 },
      "session:b": { x: 3000, y: 0 },
    });
    const n = session("n", inRepo("github.com/acme/shop", "x"));
    expect(placeDrop(n, { x: 2900, y: 100 }, model, fixed(0))).toEqual({
      x: 3000 + SPAWN_DISTANCE,
      y: 0,
    });
    expect(placeDrop(n, { x: 2900, y: 100 }, model, fixed(0.25))).toEqual({
      x: 3000,
      y: SPAWN_DISTANCE,
    });
  });

  it("tries another direction when one would cover a card", () => {
    const model = buildCanvas([a, b], {
      "session:a": { x: 0, y: 0 },
      "session:b": { x: SPAWN_DISTANCE, y: 0 },
    });
    const n = session("n", inRepo("github.com/acme/shop", "x"));
    // Angle 0 from a lands on b; half a turn lands left of a.
    expect(placeDrop(n, { x: 0, y: 0 }, model, fixed(0, 0.5))).toEqual({
      x: -SPAWN_DISTANCE,
      y: 0,
    });
  });

  it("moves a card already on the canvas rather than adding a second", () => {
    const model = buildCanvas([a], { "session:a": { x: 0, y: 0 } });
    expect(placeDrop(a, { x: 500, y: 500 }, model)).toEqual({
      x: 500 - CARD_W / 2,
      y: 500 - CARD_H / 2,
    });
  });
});

describe("applyCanvasMessage", () => {
  it("applies moves and removals", () => {
    const before = { "session:a": { x: 1, y: 1 }, "session:b": { x: 2, y: 2 } };
    expect(
      applyCanvasMessage(before, {
        type: "canvas",
        positions: { "session:a": { x: 9, y: 9 } },
        removed: ["session:b"],
      }),
    ).toEqual({ "session:a": { x: 9, y: 9 } });
  });
});

describe("floatingLine", () => {
  it("joins the two cards' edges, through their centres", () => {
    const box = (x: number, y: number) => ({ x, y, width: 100, height: 50 });
    const line = floatingLine(box(0, 0), box(300, 0));
    expect(line.start).toEqual({ x: 100, y: 25 });
    expect(line.end).toEqual({ x: 300, y: 25 });
    expect(line.mid).toEqual({ x: 200, y: 25 });
    expect(line.angle).toBe(0);
    expect(floatingLine(box(0, 300), box(0, 0)).angle).toBe(-90);
  });
});

describe("cardDomain", () => {
  it("leaves unknown blank and flags manual labels", () => {
    const unknown = session("a", {
      domain: { label: "unknown", confidence: 0, reasons: [], source: "rules" },
    });
    expect(cardDomain(unknown)).toBeUndefined();
    expect(cardDomain(session("a"))).toBeUndefined();
    const manual = session("a", {
      domain: { label: "ml", confidence: 1, reasons: [], source: "override" },
    });
    expect(cardDomain(manual)).toEqual({ label: "ml", confidence: 1, manual: true });
  });
});

describe("groupTitle", () => {
  it("names the repo from its id, or its folder for a root-commit id", () => {
    expect(groupTitle(session("a", inRepo("gitlab.com/g/sub/proj", "main"))).title).toBe("proj");
    const rooted = session("a", {
      ...inRepo("0123456789abcdef", "main", "pkg/a"),
      projectPath: "/w/tool/pkg/a",
    });
    expect(groupTitle(rooted)).toEqual({ title: "tool", subtitle: "root 0123456789" });
  });
});

describe("compareFiles", () => {
  it("matches Windows paths case-insensitively", () => {
    expect(
      compareFiles([{ path: "C:\\w\\a.ts", ranges: [] }], [{ path: "c:/w/A.ts", ranges: [] }]),
    ).toEqual({ shared: ["C:\\w\\a.ts"], level: "file" });
  });

  it("detects overlapping ranges, inclusive", () => {
    expect(rangesOverlap([[1, 5]], [[5, 9]])).toBe(true);
    expect(rangesOverlap([[1, 4]], [[5, 9]])).toBe(false);
    expect(rangesOverlap([], [[1, 9]])).toBe(false);
  });
});

describe("canvas nodes and edges", () => {
  const front = session("front", {
    ...inRepo("github.com/acme/shop", "feat/cart"),
    user: "dana",
    domain: { label: "frontend", confidence: 0.82, reasons: [], source: "rules" },
  });
  const noop = () => {};
  const handlers = {
    now: NOW,
    openId: "front",
    onOpen: noop,
    onRemove: noop,
    onDomain: noop,
    onHandoff: noop,
  };

  it("puts each group before its cards, and cards inside it", () => {
    const nodes = toNodes(buildCanvas([front], { "session:front": { x: 50, y: 80 } }), handlers);
    expect(nodes.map((n) => [n.id, n.type, n.parentId])).toEqual([
      ["repo:github.com/acme/shop", "repo", undefined],
      ["session:front", "session", "repo:github.com/acme/shop"],
    ]);
  });

  it("keeps React Flow's measurements and drags when nodes are rebuilt", () => {
    const at = (x: number) => ({ x, y: 0 });
    const current = [
      { id: "a", position: at(0), data: {}, measured: { width: 10, height: 20 }, selected: true },
      { id: "b", position: at(50), data: {}, dragging: true },
    ];
    const built = [
      { id: "a", position: at(5), data: { v: 1 } },
      { id: "b", position: at(0), data: { v: 2 } },
      { id: "c", position: at(9), data: {} },
    ];
    expect(mergeNodes<Node>(current, built)).toEqual([
      {
        id: "a",
        position: at(5),
        data: { v: 1 },
        measured: { width: 10, height: 20 },
        selected: true,
      },
      { id: "b", position: at(50), data: { v: 2 }, dragging: true },
      { id: "c", position: at(9), data: {} },
    ]);
  });

  it("saves the dragged cards, and every card of a dragged group", () => {
    const n = (id: string, type: string, parentId?: string) => ({
      id,
      type,
      position: { x: 0, y: 0 },
      data: {},
      ...(parentId === undefined ? {} : { parentId }),
    });
    const nodes = [
      n("repo:a", "repo"),
      n("session:1", "session", "repo:a"),
      n("session:2", "session", "repo:a"),
      n("repo:b", "repo"),
      n("session:3", "session", "repo:b"),
    ];
    expect(cardsMoved(nodes, [n("repo:a", "repo")])).toEqual(["session:1", "session:2"]);
    expect(cardsMoved(nodes, [n("session:3", "session", "repo:b")])).toEqual(["session:3"]);
  });

  it("places cards relative to their group's box", () => {
    const nodes = toNodes(buildCanvas([front], { "session:front": { x: 50, y: 80 } }), handlers);
    expect(nodes[1]?.position).toEqual({ x: GROUP_PAD, y: GROUP_HEAD });
  });

  it("draws links orange, red where lines overlap", () => {
    const base = { key: "k", source: "a", target: "b", label: "l", shared: [], directed: true };
    expect(LINK_COLORS.none).toBe("#ff8a2b");
    expect(toEdge({ ...base, level: "none" }).style?.stroke).toBe(LINK_COLORS.none);
    expect(toEdge({ ...base, level: "lines" }).style?.stroke).toBe(LINK_COLORS.lines);
    expect(toEdge({ ...base, level: "file" })).toMatchObject({
      type: "link",
      data: { directed: true, color: LINK_COLORS.file },
    });
  });

  it("renders a card with user, agent, domain, branch and activity", () => {
    const node = toNodes(buildCanvas([front], { "session:front": { x: 50, y: 80 } }), handlers)[1];
    if (node?.type !== "session") throw new Error("expected a session node");
    const html = renderToStaticMarkup(
      createElement(
        ReactFlowProvider,
        null,
        createElement(SessionNode, {
          id: node.id,
          type: "session",
          data: node.data,
          selected: false,
          dragging: false,
          zIndex: 1,
          isConnectable: false,
          positionAbsoluteX: 0,
          positionAbsoluteY: 0,
          draggable: true,
          selectable: true,
          deletable: false,
        }),
      ),
    );
    for (const text of ["dana", "Claude Code", "frontend", "82%", "feat/cart", "is-open"]) {
      expect(html).toContain(text);
    }
    expect(html).toContain('aria-label="Live"');
  });

  it("shows a blank domain chip when the domain is unknown", () => {
    const html = renderToStaticMarkup(
      createElement(DomainChip, { domain: undefined, onPick: () => {} }),
    );
    expect(html).toContain("is-blank");
    expect(html).not.toContain("unknown");
  });
});
