import { z } from "zod";
import { AgentId } from "../event.js";
import { TouchedFile } from "../files/schema.js";

/** Handoff ids are made by the hub: `h` + 10 base-36 characters. See docs/handoff.md. */
export const HANDOFF_ID_PATTERN = /^h[0-9a-z]{10}$/;
export const HandoffId = z.string().regex(HANDOFF_ID_PATTERN);
export type HandoffId = z.infer<typeof HandoffId>;

/** Most bytes of handoff markdown. */
export const HANDOFF_MARKDOWN_MAX = 256 * 1024;
/**
 * `full`: a summarized session (dragged by its card header). `snippet`: one
 * feed event. `chat`: the whole conversation, rendered by code from the compact
 * view (dragged from the bottom of a session's feed).
 */
export const HandoffKind = z.enum(["full", "snippet", "chat"]);
export type HandoffKind = z.infer<typeof HandoffKind>;

export const HandoffStatus = z.enum(["pending", "accepted", "declined"]);
export type HandoffStatus = z.infer<typeof HandoffStatus>;

/** The template every full handoff fills in. */
export const HandoffSummary = z.object({
  goal: z.string(),
  currentState: z.string(),
  decisions: z.array(z.string()),
  deadEnds: z.array(z.string()),
  openQuestions: z.array(z.string()),
  /** Always computed from the session's edits, never written by a model. */
  filesTouched: z.array(TouchedFile),
  nextSteps: z.array(z.string()),
});
export type HandoffSummary = z.infer<typeof HandoffSummary>;

/** One end of a handoff. */
export const HandoffParty = z.object({
  sessionId: z.string().min(1),
  /** Display name: a daemon name on a team server, else the local OS user. */
  user: z.string().optional(),
  agent: AgentId,
  repoId: z.string().nullable(),
  branch: z.string().nullable(),
});
export type HandoffParty = z.infer<typeof HandoffParty>;

export const Handoff = z.object({
  id: HandoffId,
  kind: HandoffKind,
  status: HandoffStatus,
  /** Who pressed Send, as typed in their viewer. A label, not proof of identity. */
  sender: z.string().min(1).max(64),
  /** The session the work comes from. */
  from: HandoffParty,
  /** The session that should pick it up. */
  to: HandoffParty,
  markdown: z.string().max(HANDOFF_MARKDOWN_MAX),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type Handoff = z.infer<typeof Handoff>;

// ---- viewer ↔ hub (HTTP) ---------------------------------------------------

/** `POST /handoffs/draft` body. `eventId` names the event of a snippet. */
export const HandoffDraftRequest = z.object({
  kind: HandoffKind,
  fromSessionId: z.string().min(1),
  toSessionId: z.string().min(1),
  eventId: z.string().min(1).optional(),
  /** Name for the draft's heading; the sent handoff uses `HandoffCreate.sender`. */
  sender: z.string().trim().min(1).max(64).optional(),
});
export type HandoffDraftRequest = z.infer<typeof HandoffDraftRequest>;

/** `POST /handoffs/draft` response: the preview the sender edits. */
export const HandoffDraft = z.object({
  markdown: z.string(),
  summary: HandoffSummary.optional(),
  /** What filled the template: the model, or the session itself. */
  summarizer: z.enum(["model", "heuristic", "none"]),
  /** Why the model wasn't used, when it should have been. */
  warning: z.string().optional(),
});
export type HandoffDraft = z.infer<typeof HandoffDraft>;

/** `POST /handoffs` body. */
export const HandoffCreate = HandoffDraftRequest.omit({ sender: true }).extend({
  markdown: z.string().min(1).max(HANDOFF_MARKDOWN_MAX),
  sender: z.string().trim().min(1).max(64),
});
export type HandoffCreate = z.infer<typeof HandoffCreate>;

export const HandoffResponse = z.object({ handoff: Handoff });
export type HandoffResponse = z.infer<typeof HandoffResponse>;

export const HandoffsResponse = z.object({ handoffs: z.array(Handoff) });
export type HandoffsResponse = z.infer<typeof HandoffsResponse>;
