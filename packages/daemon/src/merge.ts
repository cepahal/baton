import type { BatonEvent } from "@baton/core";

type Run = { events: BatonEvent[]; next: number };

/**
 * Interleaves several sessions' events oldest first while keeping each
 * session's own order. Timestamps can go backwards inside one transcript
 * (records of a streamed reply aren't always written in time order), so a
 * plain sort by `ts` would reorder a session's events. Instead each step takes
 * the head of whichever session's queue is oldest.
 */
export function mergeByTime(events: readonly BatonEvent[]): BatonEvent[] {
  const bySession = new Map<string, Run>();
  for (const event of events) {
    const run = bySession.get(event.sessionId);
    if (run) run.events.push(event);
    else bySession.set(event.sessionId, { events: [event], next: 0 });
  }
  const runs = [...bySession.values()];
  if (runs.length === 1) return [...events];

  const out: BatonEvent[] = [];
  while (out.length < events.length) {
    let best: Run | undefined;
    let bestMs = Number.POSITIVE_INFINITY;
    for (const run of runs) {
      const head = run.events[run.next];
      if (!head) continue;
      const ms = Date.parse(head.ts);
      const key = Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
      if (best === undefined || key < bestMs) {
        best = run;
        bestMs = key;
      }
    }
    const event = best?.events[best.next];
    if (!best || !event) break;
    out.push(event);
    best.next++;
  }
  return out;
}
