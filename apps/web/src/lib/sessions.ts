import { type SessionInfo, SessionsResponse } from "@baton/core";

/** `GET /sessions`, validated. */
export async function fetchSessions(signal?: AbortSignal): Promise<SessionInfo[]> {
  const res = await fetch("/sessions", signal ? { signal } : {});
  if (res.status === 401) {
    // A team server whose sign-in cookie is missing or stale.
    globalThis.location?.assign("/login");
    throw new Error("Not signed in to the team server");
  }
  if (!res.ok) throw new Error(`GET /sessions failed: HTTP ${res.status}`);
  return SessionsResponse.parse(await res.json()).sessions;
}

/** `DELETE /sessions/:id`: removes a session for everyone on the hub. */
export async function deleteSession(sessionId: string): Promise<void> {
  const res = await fetch(`/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404)
    throw new Error(`Couldn't delete the session: HTTP ${res.status}`);
}

/** The hub's WebSocket URL on the page's own host (the daemon, or the Vite dev proxy). */
export function defaultSocketUrl(location: Pick<Location, "protocol" | "host">): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
}
