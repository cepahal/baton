import { z } from "zod";

/** The drag payload type for a session dragged from the sidebar. */
export const SESSION_DRAG_TYPE = "application/x-baton-session";

/**
 * The drag payload type for a handoff: a card's grip (full), a feed event
 * (snippet), or the bubble at the bottom of a feed (chat: the whole conversation).
 */
export const HANDOFF_DRAG_TYPE = "application/x-baton-handoff";

export const HandoffDrag = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("full"), sessionId: z.string().min(1) }),
  z.object({ kind: z.literal("chat"), sessionId: z.string().min(1) }),
  /** A sticky note dropped on a session: `sessionId` is the receiver (a note has no source). */
  z.object({ kind: z.literal("note"), sessionId: z.string().min(1), noteId: z.string().min(1) }),
  z.object({
    kind: z.literal("snippet"),
    sessionId: z.string().min(1),
    eventId: z.string().min(1),
  }),
]);
export type HandoffDrag = z.infer<typeof HandoffDrag>;

type Transfer = Pick<DataTransfer, "setData" | "getData" | "types"> & {
  effectAllowed?: DataTransfer["effectAllowed"];
};

const DRAG_TEXT = {
  full: "Baton handoff",
  chat: "Baton chat",
  snippet: "Baton snippet",
  note: "Baton sticky note",
} as const;

/** What a handoff of each kind is called in the viewer. */
export const HANDOFF_KIND_NAMES = {
  full: "handoff",
  chat: "whole chat",
  snippet: "snippet",
  note: "sticky note",
} as const;

export function setHandoffDrag(transfer: Transfer, drag: HandoffDrag): void {
  transfer.setData(HANDOFF_DRAG_TYPE, JSON.stringify(drag));
  transfer.setData("text/plain", DRAG_TEXT[drag.kind]);
  transfer.effectAllowed = "copy";
}

export function isHandoffDrag(transfer: Pick<DataTransfer, "types">): boolean {
  return Array.from(transfer.types).includes(HANDOFF_DRAG_TYPE);
}

/** The dropped handoff, or undefined for anything else (it came from outside, so check it). */
export function readHandoffDrag(transfer: Pick<DataTransfer, "getData">): HandoffDrag | undefined {
  const text = transfer.getData(HANDOFF_DRAG_TYPE);
  if (!text) return undefined;
  try {
    const parsed = HandoffDrag.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
