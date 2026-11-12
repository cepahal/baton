import { z } from "zod";
import { ContractIssue } from "./contracts/schema.js";
import { DomainClassification, DomainLabel } from "./domain/schema.js";
import { AgentId, BatonEvent } from "./event.js";
import { TouchedFile } from "./files/schema.js";
import {
  HANDOFF_PATCH_MAX,
  Handoff,
  HandoffCode,
  HandoffDelivery,
  HandoffId,
} from "./handoff/schema.js";
import { Note, NoteId } from "./notes/schema.js";

/** Wire protocol between a Baton hub and its viewers. See docs/spec.md. */
export const PROTOCOL_VERSION = 2;

/** Hub sequence number: monotonic across all sessions within one hub epoch. */
const HubSeq = z.number().int().nonnegative();

/** `"all"` or one sessionId. */
export const Subscription = z.string().min(1);
export type Subscription = z.infer<typeof Subscription>;

// ---- client → hub ----------------------------------------------------------

export const SubscribeMessage = z.object({
  type: z.literal("subscribe"),
  session: Subscription,
  /** Last hub seq the client has; the hub replays everything after it. */
  lastSeq: HubSeq.optional(),
  /** Epoch `lastSeq` belongs to. If it isn't the hub's current epoch, `lastSeq` is ignored. */
  epoch: z.string().optional(),
});
export type SubscribeMessage = z.infer<typeof SubscribeMessage>;

export const ClientMessage = z.discriminatedUnion("type", [SubscribeMessage]);
export type ClientMessage = z.infer<typeof ClientMessage>;

/** The same subscription as WebSocket URL query parameters (`/ws?session=…&lastSeq=…`). */
export const SubscribeQuery = z.object({
  session: Subscription.default("all"),
  lastSeq: z.coerce.number().pipe(HubSeq).optional(),
  epoch: z.string().optional(),
});
export type SubscribeQuery = z.infer<typeof SubscribeQuery>;

// ---- hub → client ----------------------------------------------------------

export const HelloMessage = z.object({
  type: z.literal("hello"),
  protocol: z.literal(PROTOCOL_VERSION),
  /** Changes every time the hub restarts; seqs from another epoch mean nothing here. */
  epoch: z.string(),
  /** Latest hub seq assigned so far (0 if none). */
  seq: HubSeq,
  session: Subscription,
});
export type HelloMessage = z.infer<typeof HelloMessage>;

export const EventMessage = z.object({
  type: z.literal("event"),
  seq: HubSeq,
  /** True for events replayed from history rather than seen live. */
  backlog: z.boolean().optional(),
  event: BatonEvent,
});
export type EventMessage = z.infer<typeof EventMessage>;

/** Events `fromSeq..toSeq` were missed and are no longer in the hub's buffer. */
export const GapMessage = z.object({
  type: z.literal("gap"),
  fromSeq: HubSeq,
  toSeq: HubSeq,
});
export type GapMessage = z.infer<typeof GapMessage>;

export const ErrorMessage = z.object({
  type: z.literal("error"),
  message: z.string(),
  /**
   * Why, when the client should act on it rather than just log it:
   * `version` (update Baton) and `name_taken` (pick another `--name`) mean
   * reconnecting won't help.
   */
  code: z.enum(["version", "name_taken"]).optional(),
});
export type ErrorMessage = z.infer<typeof ErrorMessage>;

// ---- canvas ----------------------------------------------------------------

/**
 * Where a canvas node sits, in canvas coordinates. A session card with a point
 * is on the canvas; repo groups are drawn around their cards.
 */
export const CanvasPoint = z.object({ x: z.number().finite(), y: z.number().finite() });
export type CanvasPoint = z.infer<typeof CanvasPoint>;

/** Canvas node key: `repo:<group id>` or `session:<sessionId>`. */
export const CanvasKey = z
  .string()
  .regex(/^(repo|session):.+/)
  .max(512);
export type CanvasKey = z.infer<typeof CanvasKey>;

export const CanvasPositions = z.record(CanvasKey, CanvasPoint);
export type CanvasPositions = z.infer<typeof CanvasPositions>;

/** `GET /canvas` response body: every saved node position. */
export const CanvasResponse = z.object({ positions: CanvasPositions });
export type CanvasResponse = z.infer<typeof CanvasResponse>;

/** `PUT /canvas/positions` body: nodes a viewer moved, and nodes taken off the canvas. */
export const CanvasMoveBody = z.object({
  positions: CanvasPositions,
  removed: z.array(CanvasKey).max(5000).optional(),
});
export type CanvasMoveBody = z.infer<typeof CanvasMoveBody>;

/** Node positions changed (sent to every viewer); the full set right after `hello`. */
export const CanvasMessage = z.object({
  type: z.literal("canvas"),
  positions: CanvasPositions,
  /** Nodes taken off the canvas. */
  removed: z.array(CanvasKey).optional(),
  /** The whole canvas (sent on subscribe): replaces what the viewer has. */
  snapshot: z.boolean().optional(),
});
export type CanvasMessage = z.infer<typeof CanvasMessage>;

/** A handoff was created or changed status. Never carries the patch. */
export const HandoffMessage = z.object({ type: z.literal("handoff"), handoff: Handoff });
export type HandoffMessage = z.infer<typeof HandoffMessage>;

/** Sticky notes added or changed, and ones taken down; every note right after `hello`. */
export const NotesMessage = z.object({
  type: z.literal("notes"),
  notes: z.array(Note),
  removed: z.array(NoteId).optional(),
  /** Every note (sent on subscribe): replaces what the viewer has. */
  snapshot: z.boolean().optional(),
});
export type NotesMessage = z.infer<typeof NotesMessage>;

/** A session was removed from the hub (by any viewer); viewers drop its events. */
export const SessionRemovedMessage = z.object({
  type: z.literal("session_removed"),
  sessionId: z.string().min(1),
});
export type SessionRemovedMessage = z.infer<typeof SessionRemovedMessage>;

/** `GET /whoami` on a team server: the token works, and what the server runs. */
export const WhoamiResponse = z.object({
  ok: z.literal(true),
  app: z.string(),
  protocol: z.number().int().positive(),
  /** Server clock, ISO; `baton doctor` compares it with the local one. */
  now: z.iso.datetime({ offset: true }),
});
export type WhoamiResponse = z.infer<typeof WhoamiResponse>;

export const ServerMessage = z.discriminatedUnion("type", [
  HelloMessage,
  EventMessage,
  GapMessage,
  ErrorMessage,
  CanvasMessage,
  HandoffMessage,
  NotesMessage,
  SessionRemovedMessage,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

// ---- HTTP ------------------------------------------------------------------

/** Where a session's cwd sits in git. Computed by the daemon that reads the transcript. */
export const RepoInfo = z.object({
  /** Normalized remote URL (`github.com/org/repo`), else the root commit hash; null outside git. */
  repoId: z.string().min(1).nullable(),
  /** Checked-out branch; null when detached or outside git. */
  branch: z.string().min(1).nullable(),
  /** cwd relative to the repository root (`""` at the root); null outside git. */
  relativeCwd: z.string().nullable(),
});
export type RepoInfo = z.infer<typeof RepoInfo>;

/** A session's domain as `/sessions` reports it, and what decided it. */
export const SessionDomain = DomainClassification.extend({
  /** `rules`: `classifyDomain`. `llm`: the optional tie-break. `override`: set by hand. */
  source: z.enum(["rules", "llm", "override"]),
});
export type SessionDomain = z.infer<typeof SessionDomain>;

/** `PUT /sessions/:sessionId/domain` body: pin a label, or `null` to clear the override. */
export const DomainOverrideBody = z.object({ label: DomainLabel.nullable() });
export type DomainOverrideBody = z.infer<typeof DomainOverrideBody>;

export { TouchedFile };

export const SessionInfo = z.object({
  sessionId: z.string().min(1),
  /** Which coding agent the session runs in. Older servers omit it: Claude Code. */
  agent: AgentId.default("claude-code"),
  projectPath: z.string(),
  /** Last segment of `projectPath`. */
  projectName: z.string(),
  /** `ts` of the session's latest event. */
  lastActivity: z.iso.datetime({ offset: true }),
  /** Events the hub has seen for this session since it started. */
  events: z.number().int().nonnegative(),
  /** Display name of the daemon the session streams from. Only a team server sets it. */
  source: z.string().optional(),
  /** Git identity of `projectPath`, once the daemon has looked it up. */
  repo: RepoInfo.optional(),
  domain: SessionDomain.optional(),
  /** Who runs the session: the team server's daemon name, else the local OS user. */
  user: z.string().optional(),
  /** Files the session wrote (repo-relative when in git), with the lines when known. */
  files: z.array(TouchedFile).optional(),
  /** Possible I/O mismatches with other sessions in the same repo (heuristic hints). */
  contractIssues: z.array(ContractIssue).optional(),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

/** `GET /sessions` response body, most recently active first. */
export const SessionsResponse = z.object({ sessions: z.array(SessionInfo) });
export type SessionsResponse = z.infer<typeof SessionsResponse>;

/** `GET /events` query: hub log entries after `after`, oldest first. */
export const EventsQuery = z.object({
  after: z.coerce.number().pipe(HubSeq).default(0),
  limit: z.coerce.number().int().min(1).max(5000).default(1000),
});
export type EventsQuery = z.infer<typeof EventsQuery>;

/** `GET /events` response body. `events` is empty once `after` reaches `lastSeq`. */
export const EventsResponse = z.object({
  epoch: z.string(),
  /** Seq of the oldest event still held. */
  firstSeq: HubSeq,
  lastSeq: HubSeq,
  events: z.array(EventMessage),
});
export type EventsResponse = z.infer<typeof EventsResponse>;

// ---- daemon → team server (`/ingest`) --------------------------------------

/** A daemon's display name, shown to teammates. */
export const DaemonName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[\p{L}\p{N} ._@-]+$/u, "use letters, digits, spaces and . _ @ -");
export type DaemonName = z.infer<typeof DaemonName>;

/** `/ingest` WebSocket URL query. The team token goes in an `Authorization: Bearer` header. */
export const IngestQuery = z.object({
  name: DaemonName,
  /** `INGEST_PROTOCOL_VERSION` the daemon speaks. Daemons from before it existed send none. */
  protocol: z.coerce.number().int().positive().optional(),
  /** The daemon's `BATON_VERSION`, for "please update" messages and logs. */
  app: z.string().max(64).optional(),
  /** Random id kept in the daemon's state dir: tells a reconnect from another machine using the same name. */
  machine: z
    .string()
    .regex(/^[0-9a-f]{32}$/)
    .optional(),
});
export type IngestQuery = z.infer<typeof IngestQuery>;

/** A batch of events, in the order the daemon published them. */
export const PublishMessage = z.object({
  type: z.literal("publish"),
  /** Daemon-chosen id, echoed in the ack. */
  batch: z.number().int().nonnegative(),
  backlog: z.boolean().optional(),
  events: z.array(BatonEvent).min(1),
  /** Git identity of the batch's `projectPath`s, keyed by path. */
  repos: z.record(z.string(), RepoInfo).optional(),
});
export type PublishMessage = z.infer<typeof PublishMessage>;

/** Correlates a server request on `/ingest` with the daemon's answer. */
export const RequestId = z.string().regex(/^[0-9a-z]{1,32}$/);

/** What the receiving daemon did with a `handoff_write`. */
export const HandoffWriteResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), delivery: HandoffDelivery }),
  z.object({
    ok: z.literal(false),
    error: z.string().max(1000),
    /** The daemon doesn't know where to write it: ask the receiver for a folder. */
    needFolder: z.boolean().optional(),
  }),
]);
export type HandoffWriteResult = z.infer<typeof HandoffWriteResult>;

/** The receiving daemon's answer to `handoff_write`. */
export const HandoffWrittenMessage = z.object({
  type: z.literal("handoff_written"),
  requestId: RequestId,
  id: HandoffId,
  result: HandoffWriteResult,
});
export type HandoffWrittenMessage = z.infer<typeof HandoffWrittenMessage>;

/** Base64 of at most `HANDOFF_PATCH_MAX` bytes. */
const PatchBase64 = z
  .string()
  .max(Math.ceil(HANDOFF_PATCH_MAX / 3) * 4)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/);

/**
 * The sending daemon's answer to `handoff_code_request`: the patch (base64)
 * and its summary, or `unavailable` with a reason.
 */
export const HandoffCodeMessage = z.object({
  type: z.literal("handoff_code"),
  requestId: RequestId,
  code: HandoffCode.omit({ sha256: true }),
  patch: PatchBase64.optional(),
});
export type HandoffCodeMessage = z.infer<typeof HandoffCodeMessage>;

export const IngestClientMessage = z.discriminatedUnion("type", [
  PublishMessage,
  HandoffWrittenMessage,
  HandoffCodeMessage,
]);
export type IngestClientMessage = z.infer<typeof IngestClientMessage>;

/** The server holds every event of batch `batch`; the daemon may forget them. */
export const AckMessage = z.object({
  type: z.literal("ack"),
  batch: z.number().int().nonnegative(),
  /** How many of the batch's events were new; the rest were duplicates, skipped by id. */
  accepted: z.number().int().nonnegative(),
});
export type AckMessage = z.infer<typeof AckMessage>;

/**
 * A handoff for one of this daemon's sessions, sent again whenever it
 * changes. The daemon stores a pending one and notifies its user; once it is
 * no longer pending, the daemon forgets it. Nothing in it is an instruction.
 */
export const HandoffOfferMessage = z.object({
  type: z.literal("handoff_offer"),
  handoff: Handoff,
});
export type HandoffOfferMessage = z.infer<typeof HandoffOfferMessage>;

/**
 * Accept was pressed in a browser paired to this daemon's machine: write the
 * handoff's files into `folder` (or the receiving session's folder). The only
 * thing a server can make a daemon do. See docs/handoff.md.
 */
export const HandoffWriteMessage = z.object({
  type: z.literal("handoff_write"),
  requestId: RequestId,
  id: HandoffId,
  folder: z.string().min(1).max(4096).optional(),
});
export type HandoffWriteMessage = z.infer<typeof HandoffWriteMessage>;

/**
 * The sender asked, from a browser paired to this machine, to attach a
 * session's uncommitted changes. The daemon answers only for a shared session.
 */
export const HandoffCodeRequestMessage = z.object({
  type: z.literal("handoff_code_request"),
  requestId: RequestId,
  sessionId: z.string().min(1).max(256),
});
export type HandoffCodeRequestMessage = z.infer<typeof HandoffCodeRequestMessage>;

/** First message on an accepted `/ingest` connection: who the daemon is talking to. */
export const IngestHelloMessage = z.object({
  type: z.literal("ingest_hello"),
  protocol: z.number().int().positive(),
  app: z.string(),
});
export type IngestHelloMessage = z.infer<typeof IngestHelloMessage>;

export const IngestServerMessage = z.discriminatedUnion("type", [
  IngestHelloMessage,
  AckMessage,
  ErrorMessage,
  HandoffOfferMessage,
  HandoffWriteMessage,
  HandoffCodeRequestMessage,
]);
export type IngestServerMessage = z.infer<typeof IngestServerMessage>;

/** Last segment of a POSIX or Windows path. */
export function projectName(projectPath: string): string {
  const parts = projectPath.split(/[\\/]+/).filter((p) => p !== "");
  return parts.at(-1) ?? projectPath;
}
