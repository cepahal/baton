import { BlobId, HANDOFF_PATCH_MAX, NOTE_FILE_MAX_BYTES } from "@baton/core";

/** Largest file fetched: a note file or a handoff's patch. */
const FETCH_MAX_BYTES = Math.max(NOTE_FILE_MAX_BYTES, HANDOFF_PATCH_MAX);

/** The team server's HTTP base for a `--server` URL given as ws(s) or http(s). */
export function httpBase(server: string): string {
  const url = new URL(server);
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  url.pathname = url.pathname.replace(/\/(ingest)?\/?$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

/**
 * Fetches a sticky note's file or a handoff's patch from the team server,
 * checking it is the file asked for (its SHA-256) and not too big.
 */
export function remoteBlobFetcher(
  server: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): (sha256: string) => Promise<Uint8Array | undefined> {
  const base = httpBase(server);
  return async (sha256) => {
    if (!BlobId.safeParse(sha256).success) return undefined;
    const res = await fetchImpl(`${base}/blobs/${sha256}?download=1`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return undefined;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > FETCH_MAX_BYTES) return undefined;
    const digest = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
    return digest === sha256 ? bytes : undefined;
  };
}
