import {
  type CanvasPositions,
  CanvasResponse,
  type DomainLabel,
  type SessionInfo,
} from "@baton/core";

/** `GET /canvas`: the team's saved node positions. */
export async function fetchCanvas(signal?: AbortSignal): Promise<CanvasPositions> {
  const res = await fetch("/canvas", signal ? { signal } : {});
  if (!res.ok) throw new Error(`GET /canvas failed: HTTP ${res.status}`);
  return CanvasResponse.parse(await res.json()).positions;
}

/**
 * `PUT /canvas/positions`: nodes this viewer moved or took off the canvas. The
 * hub echoes the change to everyone.
 */
export async function saveCanvas(
  positions: CanvasPositions,
  removed: readonly string[] = [],
): Promise<void> {
  const res = await fetch("/canvas/positions", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(removed.length > 0 ? { positions, removed } : { positions }),
  });
  if (!res.ok) throw new Error(`PUT /canvas/positions failed: HTTP ${res.status}`);
}

/** `PUT /sessions/:id/domain`: set a session's domain by hand, or clear it with `null`. */
export async function saveDomain(
  session: Pick<SessionInfo, "sessionId">,
  label: DomainLabel | null,
): Promise<void> {
  const res = await fetch(`/sessions/${encodeURIComponent(session.sessionId)}/domain`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label }),
  });
  if (!res.ok) throw new Error(`Setting the domain failed: HTTP ${res.status}`);
}
