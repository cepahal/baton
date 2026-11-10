import { z } from "zod";
import { AgentId } from "../event.js";
import { TouchedFile } from "../files/schema.js";
import { NoteFile, NoteId } from "../notes/schema.js";

/** Handoff ids are made by the hub: `h` + 10 base-36 characters. See docs/handoff.md. */
export const HANDOFF_ID_PATTERN = /^h[0-9a-z]{10}$/;
export const HandoffId = z.string().regex(HANDOFF_ID_PATTERN);
export type HandoffId = z.infer<typeof HandoffId>;

/** Most bytes of handoff markdown. */
export const HANDOFF_MARKDOWN_MAX = 256 * 1024;
/**
 * `full`: a summarized session (dragged by its card header). `snippet`: one
 * feed event. `chat`: the whole conversation, rendered by code from the compact
 * view (dragged from the bottom of a session's feed). `note`: a sticky note
 * from the canvas, with its files (dragged onto a session; the note stays).
 */
export const HandoffKind = z.enum(["full", "snippet", "chat", "note"]);
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
  /** The daemon that runs the session, on a team server. Absent locally. */
  daemon: z.string().max(64).optional(),
});
export type HandoffParty = z.infer<typeof HandoffParty>;

/** Most bytes of a handoff's patch. */
export const HANDOFF_PATCH_MAX = 5 * 1024 * 1024;
/** Most characters of a decline note. */
export const HANDOFF_NOTE_MAX = 500;

export const CommitId = z.string().regex(/^[0-9a-f]{40,64}$/);
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const RepoPath = z.string().max(4096);

/** A file left out of a patch, and why. */
export const SkippedFile = z.object({ path: RepoPath, reason: z.string().max(200) });
export type SkippedFile = z.infer<typeof SkippedFile>;

/**
 * The sender's uncommitted changes. `attached`: the patch is a blob on the hub
 * (`sha256`). `unavailable`: the sender asked for it but there is none;
 * `reason` says why.
 */
export const HandoffCode = z.object({
  state: z.enum(["attached", "unavailable"]),
  sha256: Sha256.optional(),
  bytes: z.number().int().nonnegative().optional(),
  /** The commit the patch is against. */
  base: CommitId.optional(),
  branch: z.string().max(256).nullable().optional(),
  files: z.array(RepoPath).max(10_000).optional(),
  skipped: z.array(SkippedFile).max(10_000).optional(),
  /** Files where key-like strings were masked. */
  redacted: z.array(RepoPath).max(10_000).optional(),
  reason: z.string().max(500).optional(),
});
export type HandoffCode = z.infer<typeof HandoffCode>;

/** Whether `baton handoff apply` can put the patch on a branch in the destination. */
export const HandoffApply = z.object({
  available: z.boolean(),
  reason: z.string().max(500).optional(),
});
export type HandoffApply = z.infer<typeof HandoffApply>;

/** Where an accepted handoff was written on the receiver's machine. */
export const HandoffDelivery = z.object({
  folder: z.string().min(1).max(4096),
  /** The markdown file. */
  path: z.string().min(1).max(4096),
  apply: HandoffApply,
});
export type HandoffDelivery = z.infer<typeof HandoffDelivery>;

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
  /** Files copied from a sticky note, fetched by the receiver on accept. */
  attachments: z.array(NoteFile).optional(),
  /** The sender's uncommitted changes, when they attached them. */
  code: HandoffCode.optional(),
  /** The receiver's note when declining. */
  note: z.string().max(HANDOFF_NOTE_MAX).optional(),
  /** Set on accept: where the receiver's daemon wrote it. */
  delivery: HandoffDelivery.optional(),
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
  /** The sticky note of a `note` handoff. */
  noteId: NoteId.optional(),
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
  /** Whether this browser may attach the sender's uncommitted changes (paired to their machine). */
  canAttachCode: z.boolean().optional(),
});
export type HandoffDraft = z.infer<typeof HandoffDraft>;

/** `POST /handoffs` body. */
export const HandoffCreate = HandoffDraftRequest.omit({ sender: true }).extend({
  markdown: z.string().min(1).max(HANDOFF_MARKDOWN_MAX),
  sender: z.string().trim().min(1).max(64),
  /** Attach the sending session's uncommitted changes as a patch. */
  attachCode: z.boolean().optional(),
});
export type HandoffCreate = z.infer<typeof HandoffCreate>;

/** `POST /handoffs/:id/accept` body. `folder`: where to write it, when the default won't do. */
export const HandoffAcceptRequest = z.object({
  folder: z.string().trim().min(1).max(4096).optional(),
});
export type HandoffAcceptRequest = z.infer<typeof HandoffAcceptRequest>;

/** `POST /handoffs/:id/decline` body. */
export const HandoffDeclineRequest = z.object({
  note: z.string().trim().max(HANDOFF_NOTE_MAX).optional(),
});
export type HandoffDeclineRequest = z.infer<typeof HandoffDeclineRequest>;

/** An accept or decline that didn't go through. `needFolder`: ask the receiver where to write it. */
export const HandoffAnswerError = z.object({
  error: z.string(),
  needFolder: z.boolean().optional(),
});
export type HandoffAnswerError = z.infer<typeof HandoffAnswerError>;

/** `GET /handoffs/:id`: the handoff, and whether this browser may answer it. */
export const HandoffView = z.object({
  handoff: Handoff,
  canAnswer: z.boolean(),
  /** Why not, when it can't. */
  why: z.string().optional(),
});
export type HandoffView = z.infer<typeof HandoffView>;

export const HandoffResponse = z.object({ handoff: Handoff });
export type HandoffResponse = z.infer<typeof HandoffResponse>;

export const HandoffsResponse = z.object({ handoffs: z.array(Handoff) });
export type HandoffsResponse = z.infer<typeof HandoffsResponse>;
