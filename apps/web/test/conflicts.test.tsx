import type { ContractIssue, Handoff } from "@baton/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ContractCaution } from "../src/components/canvas/ContractCaution.js";
import { SPLIT_GAP, splitPath } from "../src/components/canvas/LinkEdge.js";
import { applyCanvasMessage } from "../src/hooks/useCanvasPositions.js";
import { mergeHandoffs } from "../src/lib/handoff-api.js";

/** The `M x y L x y` segments of a path, as numbers. */
function segments(d: string): number[][] {
  return [...d.matchAll(/M ([-\d.]+) ([-\d.]+) L ([-\d.]+) ([-\d.]+)/g)].map((m) =>
    m.slice(1, 5).map(Number),
  );
}

describe("splitPath (conflict links)", () => {
  it("breaks a long line in the middle, leaving a gap, with a tick on each side", () => {
    const segs = segments(splitPath({ x: 0, y: 0 }, { x: 200, y: 0 }, SPLIT_GAP));
    expect(segs).toHaveLength(4); // line, tick, line, tick
    const [first, , second] = segs;
    expect(first).toEqual([0, 0, 86, 0]);
    expect(second).toEqual([114, 0, 200, 0]);
    expect((second?.[0] ?? 0) - (first?.[2] ?? 0)).toBe(SPLIT_GAP);
  });

  it("works at any angle and keeps both ends where they were", () => {
    const segs = segments(splitPath({ x: 10, y: 10 }, { x: 110, y: 110 }, SPLIT_GAP));
    expect(segs[0]?.slice(0, 2)).toEqual([10, 10]);
    expect(segs[2]?.slice(2, 4)).toEqual([110, 110]);
  });

  it("draws a short link whole rather than all gap", () => {
    expect(segments(splitPath({ x: 0, y: 0 }, { x: 20, y: 0 }, SPLIT_GAP))).toEqual([
      [0, 0, 20, 0],
    ]);
  });
});

const issue = (message: string): ContractIssue => ({
  kind: "shape",
  message,
  otherSessionId: "be",
});

describe("ContractCaution", () => {
  it("renders nothing without issues", () => {
    expect(renderToStaticMarkup(createElement(ContractCaution, { issues: undefined }))).toBe("");
    expect(renderToStaticMarkup(createElement(ContractCaution, { issues: [] }))).toBe("");
  });

  it("shows a caution sign with the first issue, a count, and all of them on hover", () => {
    const html = renderToStaticMarkup(
      createElement(ContractCaution, {
        issues: [
          issue("`Order`: 47 fields here vs 36 there"),
          issue("Calls POST /api/x, not defined"),
        ],
      }),
    );
    expect(html).toContain("⚠");
    expect(html).toContain("47 fields here vs 36 there</span>");
    expect(html).toContain("+1");
    expect(html).toContain("Calls POST /api/x");
  });
});

describe("applyCanvasMessage", () => {
  it("replaces everything on a snapshot, so nodes removed while away are gone", () => {
    const held = { "session:a": { x: 1, y: 1 }, "session:gone": { x: 2, y: 2 } };
    expect(
      applyCanvasMessage(held, {
        type: "canvas",
        positions: { "session:a": { x: 5, y: 5 } },
        snapshot: true,
      }),
    ).toEqual({ "session:a": { x: 5, y: 5 } });
    expect(applyCanvasMessage(held, { type: "canvas", positions: {}, snapshot: true })).toEqual({});
  });

  it("merges a delta", () => {
    expect(
      applyCanvasMessage(
        { "session:a": { x: 1, y: 1 } },
        {
          type: "canvas",
          positions: { "session:b": { x: 3, y: 3 } },
          removed: ["session:a"],
        },
      ),
    ).toEqual({ "session:b": { x: 3, y: 3 } });
  });
});

describe("mergeHandoffs", () => {
  const h = (status: Handoff["status"], updatedAt: string, id = "h0000000001"): Handoff =>
    ({
      id,
      status,
      createdAt: "2026-11-03T00:00:00.000Z",
      updatedAt,
    }) as Handoff;

  it("keeps a newer socket update over an older fetched copy", () => {
    const live = [h("accepted", "2026-11-03T00:00:05.000Z")];
    expect(mergeHandoffs(live, h("pending", "2026-11-03T00:00:01.000Z"))[0]?.status).toBe(
      "accepted",
    );
  });

  it("takes newer updates and adds new handoffs, newest first", () => {
    const list = mergeHandoffs(
      [h("pending", "2026-11-03T00:00:01.000Z")],
      h("declined", "2026-11-03T00:00:02.000Z"),
    );
    expect(list.map((x) => x.status)).toEqual(["declined"]);
    const two = mergeHandoffs(list, {
      ...h("pending", "2026-11-03T00:01:00.000Z", "h0000000002"),
      createdAt: "2026-11-03T00:01:00.000Z",
    });
    expect(two.map((x) => x.id)).toEqual(["h0000000002", "h0000000001"]);
  });
});
