import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentId, CommitId, HANDOFF_ID_PATTERN } from "@baton/core";
import { z } from "zod";

/**
 * `.baton/handoffs/<id>/handoff.json`: what the local `baton handoff apply`
 * and `baton handoff start` commands need, written next to the markdown when a
 * handoff is accepted.
 */
export const HandoffMeta = z.object({
  id: z.string().regex(HANDOFF_ID_PATTERN),
  /** The receiving session's agent. */
  agent: AgentId,
  sender: z.string().max(64),
  /** The sender's repo, or null outside git. */
  repoId: z.string().nullable(),
  branch: z.string().max(256).nullable(),
  /** The commit `changes.patch` is against. */
  base: CommitId.nullable(),
  /** Whether `changes.patch` was written. */
  patch: z.boolean(),
});
export type HandoffMeta = z.infer<typeof HandoffMeta>;

/** Reads a written handoff's `handoff.json` from `dir`, or explains why it can't. */
export async function readHandoffMeta(
  dir: string,
  id: string,
): Promise<{ ok: true; meta: HandoffMeta; dir: string } | { ok: false; error: string }> {
  if (!HANDOFF_ID_PATTERN.test(id)) return { ok: false, error: `${id} is not a handoff id.` };
  const filesDir = join(dir, ".baton", "handoffs", id);
  let text: string;
  try {
    text = await readFile(join(filesDir, "handoff.json"), "utf8");
  } catch {
    return {
      ok: false,
      error: `No handoff ${id} here. Run this in the folder the handoff was accepted into.`,
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: `${join(filesDir, "handoff.json")} is not valid JSON.` };
  }
  const parsed = HandoffMeta.safeParse(json);
  if (!parsed.success || parsed.data.id !== id) {
    return { ok: false, error: `${join(filesDir, "handoff.json")} is not a Baton handoff.` };
  }
  return { ok: true, meta: parsed.data, dir: filesDir };
}
