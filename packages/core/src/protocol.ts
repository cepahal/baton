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
});
export type SessionInfo = z.infer<typeof SessionInfo>;

/** `GET /sessions` response body, most recently active first. */
export const SessionsResponse = z.object({ sessions: z.array(SessionInfo) });
export type SessionsResponse = z.infer<typeof SessionsResponse>;

/** Last segment of a POSIX or Windows path. */
export function projectName(projectPath: string): string {
  const parts = projectPath.split(/[\\/]+/).filter((p) => p !== "");
  return parts.at(-1) ?? projectPath;
}
