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

/** The hub's WebSocket URL on the page's own host (the daemon, or the Vite dev proxy). */
export function defaultSocketUrl(location: Pick<Location, "protocol" | "host">): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
}
