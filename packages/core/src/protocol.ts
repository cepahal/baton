import { z } from "zod";
import { BatonEvent } from "./event.js";

/** Wire protocol between a Baton hub and its viewers. See docs/spec.md. */
export const PROTOCOL_VERSION = 1;

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
});
export type ErrorMessage = z.infer<typeof ErrorMessage>;

export const ServerMessage = z.discriminatedUnion("type", [
  HelloMessage,
  EventMessage,
  GapMessage,
  ErrorMessage,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

// ---- HTTP ------------------------------------------------------------------

export const SessionInfo = z.object({
  sessionId: z.string().min(1),
  projectPath: z.string(),
  /** Last segment of `projectPath`. */
  projectName: z.string(),
  /** `ts` of the session's latest event. */
  lastActivity: z.iso.datetime({ offset: true }),
  /** Events the hub has seen for this session since it started. */
  events: z.number().int().nonnegative(),
  /** Display name of the daemon the session streams from. Only a team server sets it. */
  source: z.string().optional(),
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
export const IngestQuery = z.object({ name: DaemonName });
export type IngestQuery = z.infer<typeof IngestQuery>;

/** A batch of events, in the order the daemon published them. */
export const PublishMessage = z.object({
  type: z.literal("publish"),
  /** Daemon-chosen id, echoed in the ack. */
  batch: z.number().int().nonnegative(),
  backlog: z.boolean().optional(),
  events: z.array(BatonEvent).min(1),
});
export type PublishMessage = z.infer<typeof PublishMessage>;

export const IngestClientMessage = z.discriminatedUnion("type", [PublishMessage]);
export type IngestClientMessage = z.infer<typeof IngestClientMessage>;

/** The server holds every event of batch `batch`; the daemon may forget them. */
export const AckMessage = z.object({
  type: z.literal("ack"),
  batch: z.number().int().nonnegative(),
  /** How many of the batch's events were new; the rest were duplicates, skipped by id. */
  accepted: z.number().int().nonnegative(),
});
export type AckMessage = z.infer<typeof AckMessage>;

export const IngestServerMessage = z.discriminatedUnion("type", [AckMessage, ErrorMessage]);
export type IngestServerMessage = z.infer<typeof IngestServerMessage>;

/** Last segment of a POSIX or Windows path. */
export function projectName(projectPath: string): string {
  const parts = projectPath.split(/[\\/]+/).filter((p) => p !== "");
  return parts.at(-1) ?? projectPath;
}
