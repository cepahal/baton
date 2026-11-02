import { z } from "zod";

export const POSITIONS_KEY = "baton.cardPositions";
/** Board grid pitch in px; cards snap to it. */
export const GRID = 32;
/** Card size: 6 × 8 cells, a vertical 3:4. */
export const CARD_W = GRID * 6;
export const CARD_H = GRID * 8;

const Point = z.object({ x: z.number(), y: z.number() });
export type Point = z.infer<typeof Point>;
export type Positions = Record<string, Point>;
const Stored = z.record(z.string(), Point).catch({});

/** Keeps a dropped top-left corner on the board (never negative), exactly where dropped. */
export function place(p: Point): Point {
  return { x: Math.max(0, Math.round(p.x)), y: Math.max(0, Math.round(p.y)) };
}

/** Snaps a top-left corner to the grid, kept on the board (never negative). */
export function snap(p: Point): Point {
  return {
    x: Math.max(0, Math.round(p.x / GRID) * GRID),
    y: Math.max(0, Math.round(p.y / GRID) * GRID),
  };
}

const overlaps = (a: Point, b: Point) =>
  Math.abs(a.x - b.x) < CARD_W && Math.abs(a.y - b.y) < CARD_H;

/** The first free slot, reading left to right, for a card with no position yet. */
export function firstFree(taken: readonly Point[], columns: number): Point {
  const cols = Math.max(1, columns);
  for (let i = 0; ; i++) {
    const p = {
      x: GRID + (i % cols) * (CARD_W + GRID),
      y: GRID + Math.floor(i / cols) * (CARD_H + GRID),
    };
    if (!taken.some((t) => overlaps(t, p))) return p;
  }
}

/** Positions for every id: saved ones kept, new ones put in free slots. */
export function layout(ids: readonly string[], saved: Positions, columns: number): Positions {
  const out: Positions = {};
  for (const id of ids) {
    const p = saved[id];
    if (p) out[id] = p;
  }
  for (const id of ids) {
    if (!out[id]) out[id] = firstFree(Object.values(out), columns);
  }
  return out;
}

export function loadPositions(storage: Pick<Storage, "getItem"> | undefined): Positions {
  try {
    const raw = storage?.getItem(POSITIONS_KEY) ?? null;
    return raw === null ? {} : Stored.parse(JSON.parse(raw));
  } catch {
    return {};
  }
}

export function savePositions(storage: Pick<Storage, "setItem"> | undefined, p: Positions): void {
  try {
    storage?.setItem(POSITIONS_KEY, JSON.stringify(p));
  } catch {
    // Storage may be full or unavailable; positions just won't persist.
  }
}
