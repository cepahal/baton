import { z } from "zod";
import { DaemonName } from "../protocol.js";

/** A daemon's random machine id (`IngestQuery.machine`). */
export const MachineId = z.string().regex(/^[0-9a-f]{32}$/);
export type MachineId = z.infer<typeof MachineId>;

/** How long a pairing code works. */
export const PAIRING_CODE_TTL_MS = 10 * 60_000;

/** The machine a browser is paired to: a daemon name and that daemon's machine id. */
export const Pairing = z.object({ name: DaemonName, machine: MachineId });
export type Pairing = z.infer<typeof Pairing>;

/** `POST /pair` body: a daemon asks for a one-time code for its own name and machine. */
export const PairRequest = Pairing;
export type PairRequest = z.infer<typeof PairRequest>;

/** `POST /pair` response. The code goes in the pairing link's fragment. */
export const PairCodeResponse = z.object({
  code: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expiresAt: z.iso.datetime({ offset: true }),
});
export type PairCodeResponse = z.infer<typeof PairCodeResponse>;

/** `POST /pair/claim` body, from the pairing page. */
export const PairClaimRequest = z.object({ code: z.string().min(1).max(128) });
export type PairClaimRequest = z.infer<typeof PairClaimRequest>;

/** `GET /me`: `local` on `baton start`, where the only browser is this machine's. */
export const MeResponse = z.object({
  local: z.boolean(),
  pairing: Pairing.nullable(),
});
export type MeResponse = z.infer<typeof MeResponse>;
