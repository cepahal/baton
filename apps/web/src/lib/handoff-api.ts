import {
  type Handoff,
  HandoffAnswerError,
  type HandoffCreate,
  HandoffDraft,
  type HandoffDraftRequest,
  HandoffResponse,
  HandoffsResponse,
  HandoffView,
  MeResponse,
} from "@baton/core";
import { z } from "zod";

async function failure(res: Response, what: string): Promise<Error> {
  const body: unknown = await res.json().catch(() => undefined);
  const parsed = z.object({ error: z.string() }).safeParse(body);
  return new Error(parsed.success ? parsed.data.error : `${what} failed: HTTP ${res.status}`);
}

/** `POST /handoffs/draft`: the packet to preview and edit before sending. */
export async function draftHandoff(
  request: HandoffDraftRequest,
  signal?: AbortSignal,
): Promise<HandoffDraft> {
  const res = await fetch("/handoffs/draft", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw await failure(res, "Drafting the handoff");
  return HandoffDraft.parse(await res.json());
}

/** `POST /handoffs`: send it. */
export async function sendHandoff(body: z.input<typeof HandoffCreate>): Promise<Handoff> {
  const res = await fetch("/handoffs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await failure(res, "Sending the handoff");
  return HandoffResponse.parse(await res.json()).handoff;
}

export async function fetchHandoffs(signal?: AbortSignal): Promise<Handoff[]> {
  const res = await fetch("/handoffs", signal ? { signal } : {});
  if (!res.ok) throw await failure(res, "Loading handoffs");
  return HandoffsResponse.parse(await res.json()).handoffs;
}

/** `GET /handoffs/:id`: the handoff and whether this browser may answer it. */
export async function fetchHandoffView(id: string, signal?: AbortSignal): Promise<HandoffView> {
  const res = await fetch(`/handoffs/${encodeURIComponent(id)}`, {
    headers: { accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw await failure(res, "Loading the handoff");
  return HandoffView.parse(await res.json());
}

export type AcceptResult =
  | { ok: true; handoff: Handoff }
  | { ok: false; error: string; needFolder: boolean };

/**
 * `POST /handoffs/:id/accept`: the receiving machine writes the handoff into
 * `folder` (or its session's folder). That is all accepting does.
 */
export async function acceptHandoff(id: string, folder?: string): Promise<AcceptResult> {
  const res = await fetch(`/handoffs/${encodeURIComponent(id)}/accept`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(folder ? { folder } : {}),
  });
  const body: unknown = await res.json().catch(() => undefined);
  if (res.ok) return { ok: true, handoff: HandoffResponse.parse(body).handoff };
  const parsed = HandoffAnswerError.safeParse(body);
  return {
    ok: false,
    error: parsed.success ? parsed.data.error : `Accepting failed: HTTP ${res.status}`,
    needFolder: parsed.success && parsed.data.needFolder === true,
  };
}

/** `POST /handoffs/:id/decline`, with an optional note for the sender. */
export async function declineHandoff(id: string, note?: string): Promise<Handoff> {
  const res = await fetch(`/handoffs/${encodeURIComponent(id)}/decline`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(note ? { note } : {}),
  });
  if (!res.ok) throw await failure(res, "Declining");
  return HandoffResponse.parse(await res.json()).handoff;
}

/** `GET /me`: which machine, if any, this browser answers handoffs for. */
export async function fetchMe(signal?: AbortSignal): Promise<MeResponse> {
  const res = await fetch("/me", signal ? { signal } : {});
  if (!res.ok) throw await failure(res, "Loading who you are");
  return MeResponse.parse(await res.json());
}

/** `POST /pair/claim`: pairs this browser with the machine that made the code. */
export async function claimPairing(code: string): Promise<MeResponse> {
  const res = await fetch("/pair/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) throw await failure(res, "Pairing");
  return MeResponse.parse(await res.json());
}

/** Whether this browser answers for the machine a handoff is addressed to. */
export function isForMe(handoff: Handoff, me: MeResponse | undefined): boolean {
  if (!me) return false;
  if (me.local) return true;
  return me.pairing !== null && handoff.to.daemon === me.pairing.name;
}

/** Newest first, one per id, the latest update winning. */
export function mergeHandoffs(list: readonly Handoff[], update: Handoff): Handoff[] {
  // A fetched list can be older than a socket update that already landed.
  const held = list.find((h) => h.id === update.id);
  if (held && held.updatedAt > update.updatedAt) return [...list];
  const rest = list.filter((h) => h.id !== update.id);
  return [update, ...rest].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const SENDER_KEY = "baton.handoff.sender";

/** The name the sender types once; a label for teammates, not an identity. */
export function loadSender(storage: Pick<Storage, "getItem"> | undefined): string {
  try {
    return storage?.getItem(SENDER_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveSender(storage: Pick<Storage, "setItem"> | undefined, name: string): void {
  try {
    storage?.setItem(SENDER_KEY, name);
  } catch {
    // private mode: not remembered
  }
}
