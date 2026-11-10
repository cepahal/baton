import { PairCodeResponse } from "@baton/core";
import { httpBase } from "./remote-blobs.js";

export type PairLink = { url: string; expiresAt: string };

/**
 * Asks the team server for a one-time pairing link for this daemon's machine.
 * The code rides in the URL's fragment, which browsers never send to a server,
 * so it stays out of access logs. Never log the returned URL.
 */
export async function requestPairLink(
  options: { server: string; token: string; name: string; machine: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; link: PairLink } | { ok: false; error: string }> {
  const base = httpBase(options.server);
  let res: Response;
  try {
    res = await fetchImpl(`${base}/pair`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: options.name, machine: options.machine }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return { ok: false, error: `could not reach ${base}: ${String(err)}` };
  }
  const body: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const error =
      typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
        ? body.error
        : `the server answered ${res.status}`;
    return { ok: false, error };
  }
  const parsed = PairCodeResponse.safeParse(body);
  if (!parsed.success) return { ok: false, error: "the server sent an unexpected answer" };
  return {
    ok: true,
    link: { url: `${base}/pair#${parsed.data.code}`, expiresAt: parsed.data.expiresAt },
  };
}
