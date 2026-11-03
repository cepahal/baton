import {
  type Handoff,
  type HandoffCreate,
  HandoffDraft,
  type HandoffDraftRequest,
  HandoffResponse,
  HandoffsResponse,
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

const InboxList = z.object({
  offers: z.array(
    z.object({
      id: z.string(),
      sender: z.string(),
      kind: z.string(),
      status: z.string(),
      url: z.string(),
    }),
  ),
});
export type InboxEntry = z.infer<typeof InboxList>["offers"][number];

/** `GET /inbox`: offers waiting on this machine. Empty where there's no local inbox (team server). */
export async function fetchInbox(signal?: AbortSignal): Promise<InboxEntry[]> {
  const res = await fetch("/inbox", signal ? { signal } : {});
  if (!res.ok) return [];
  const parsed = InboxList.safeParse(await res.json().catch(() => undefined));
  return parsed.success ? parsed.data.offers : [];
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
