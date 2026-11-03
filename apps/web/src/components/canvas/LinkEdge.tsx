import {
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  type InternalNode,
  useInternalNode,
} from "@xyflow/react";
import type { LinkLevel } from "../../lib/canvas-model.js";

export type LinkEdgeData = {
  label: string;
  level: LinkLevel;
  /** Draw an arrow mid-line pointing from source to target. */
  directed: boolean;
  shared: string[];
  color: string;
};

export type LinkEdgeType = Edge<LinkEdgeData, "link">;

type Point = { x: number; y: number };
type Rect = Point & { width: number; height: number };

/** A straight line between two cards' edges, with its label and, for a flow, an arrow. */
export function LinkEdge({ id, source, target, data, style }: EdgeProps<LinkEdgeType>) {
  const from = rectOf(useInternalNode(source));
  const to = rectOf(useInternalNode(target));
  if (!from || !to || !data) return null;
  const { start, end, mid, angle } = floatingLine(from, to);
  const conflict = data.level !== "none";
  const d = conflict
    ? splitPath(start, end, SPLIT_GAP)
    : `M ${start.x} ${start.y} L ${end.x} ${end.y}`;
  return (
    <>
      {conflict && (
        // Wide blurred copy under the line: the glow.
        <path className={`link-glow is-${data.level}`} d={d} stroke={data.color} fill="none" />
      )}
      <path id={id} className="react-flow__edge-path" d={d} style={style} fill="none" />
      {data.directed && (
        <path
          className="link-arrow"
          d="M 11 0 L -9 -9 L -4 0 L -9 9 Z"
          transform={`translate(${mid.x} ${mid.y}) rotate(${angle})`}
          fill={data.color}
        />
      )}
      <EdgeLabelRenderer>
        <div
          className={`link-label is-${data.level} nodrag nopan`}
          style={{
            // Below the line when the middle holds an arrow or the split.
            transform: `translate(-50%, ${data.directed || conflict ? "12px" : "-50%"}) translate(${mid.x}px, ${mid.y}px)`,
            color: data.level === "none" ? undefined : data.color,
          }}
          title={
            data.shared.length > 0
              ? `Possible merge conflict${data.level === "lines" ? " (same lines)" : ""}: ${data.shared.join(", ")}`
              : undefined
          }
        >
          {data.label}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

/** Pixels left open in the middle of a conflict line (the "split"). */
export const SPLIT_GAP = 28;

/**
 * A straight line from `a` to `b` broken in the middle: two segments with a
 * `gap` between them, each ending in a short tick across the line. A line
 * shorter than the gap plus ticks is drawn whole.
 */
export function splitPath(a: Point, b: Point, gap: number): string {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len <= gap + 8) return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
  const ux = dx / len;
  const uy = dy / len;
  const half = (len - gap) / 2;
  const p1 = { x: a.x + ux * half, y: a.y + uy * half };
  const p2 = { x: b.x - ux * half, y: b.y - uy * half };
  // Ticks perpendicular to the line, slanted like a break mark.
  const t = 7;
  const tick = (p: Point) =>
    `M ${r(p.x - uy * t - ux * 3)} ${r(p.y + ux * t - uy * 3)} L ${r(p.x + uy * t + ux * 3)} ${r(p.y - ux * t + uy * 3)}`;
  return [
    `M ${r(a.x)} ${r(a.y)} L ${r(p1.x)} ${r(p1.y)}`,
    tick(p1),
    `M ${r(p2.x)} ${r(p2.y)} L ${r(b.x)} ${r(b.y)}`,
    tick(p2),
  ].join(" ");
}

const r = (n: number) => Math.round(n * 10) / 10;

function rectOf(node: InternalNode | undefined): Rect | undefined {
  if (!node) return undefined;
  const width = node.measured.width ?? 0;
  const height = node.measured.height ?? 0;
  if (width === 0 || height === 0) return undefined;
  return { ...node.internals.positionAbsolute, width, height };
}

/**
 * The segment joining two rectangles' centres, cut where it leaves each one,
 * with its midpoint and direction in degrees.
 */
export function floatingLine(
  a: Rect,
  b: Rect,
): { start: Point; end: Point; mid: Point; angle: number } {
  const ca = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const cb = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const dx = cb.x - ca.x;
  const dy = cb.y - ca.y;
  const exit = (r: Rect, c: Point, sx: number, sy: number): Point => {
    const t = Math.min(
      dx === 0 ? Number.POSITIVE_INFINITY : r.width / 2 / Math.abs(dx),
      dy === 0 ? Number.POSITIVE_INFINITY : r.height / 2 / Math.abs(dy),
    );
    const k = Number.isFinite(t) ? t : 0;
    return { x: c.x + sx * dx * k, y: c.y + sy * dy * k };
  };
  const start = exit(a, ca, 1, 1);
  const end = exit(b, cb, -1, -1);
  return {
    start,
    end,
    mid: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
    angle: (Math.atan2(dy, dx) * 180) / Math.PI,
  };
}
