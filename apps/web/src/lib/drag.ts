import { z } from "zod";

/** The drag payload type for a session dragged from the sidebar. */
export const SESSION_DRAG_TYPE = "application/x-baton-session";
/** The drag payload type for a card moved on the board. */
export const CARD_DRAG_TYPE = "application/x-baton-card";

/** Which card is moving and where in it the pointer grabbed it. */
export const CardDrag = z.object({ id: z.string().min(1), dx: z.number(), dy: z.number() });
export type CardDrag = z.infer<typeof CardDrag>;

export function parseCardDrag(raw: string): CardDrag | undefined {
  try {
    const r = CardDrag.safeParse(JSON.parse(raw));
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a point lies outside a rect: a card dropped there leaves the board. */
export function isOutside(
  p: { x: number; y: number },
  r: { left: number; top: number; right: number; bottom: number },
): boolean {
  return p.x < r.left || p.x > r.right || p.y < r.top || p.y > r.bottom;
}
