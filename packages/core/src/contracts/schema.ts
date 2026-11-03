import { z } from "zod";

/** HTTP method of a route or call; `ANY` when the code doesn't say. */
export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "ANY"] as const;
export const HttpMethod = z.enum(HTTP_METHODS);
export type HttpMethod = z.infer<typeof HttpMethod>;

/** The wire type of a field, as far as a glance at the declaration tells. */
export const FIELD_KINDS = ["string", "number", "boolean", "array", "object", "unknown"] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

/** An endpoint a session defined (backend) or called (frontend). */
export type Endpoint = {
  method: HttpMethod;
  /** Normalized: no origin or query, params as `:param`, no trailing slash. */
  path: string;
  /** File it was written in, as the event gave it. */
  file: string;
};

export type ShapeField = { name: string; kind: FieldKind };

/** A named data shape: a TS interface/type, zod object, pydantic model, Go struct. */
export type Shape = {
  name: string;
  fields: ShapeField[];
  file: string;
};

/** What one written file said about the code's inputs and outputs. */
export type FileContracts = {
  routes: Endpoint[];
  calls: Endpoint[];
  shapes: Shape[];
};

/** A possible I/O mismatch between two sessions, worded for a one-line tooltip. */
export const ContractIssue = z.object({
  kind: z.enum(["route", "shape"]),
  message: z.string().min(1).max(240),
  /** The other session involved. */
  otherSessionId: z.string().min(1),
});
export type ContractIssue = z.infer<typeof ContractIssue>;
