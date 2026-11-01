/** "just now", "42s ago", "5m ago", "3h ago", "2d ago". */
export function formatAgo(thenMs: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Local wall-clock time, `HH:MM:SS`. */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour12: false });
}

/** A session counts as live if it produced an event this recently. */
export const LIVE_WINDOW_MS = 90_000;

export function isLive(lastActivity: string, nowMs: number): boolean {
  const t = Date.parse(lastActivity);
  return !Number.isNaN(t) && nowMs - t < LIVE_WINDOW_MS;
}
