import type { BatonEvent } from "@baton/core";
import { metaBool, metaString } from "./meta.js";

export type FeedRow =
  | { type: "event"; key: string; event: BatonEvent }
  | {
      /** A run of subagent events, shown as one collapsed group. */
      type: "sidechain";
      key: string;
      agentId: string | undefined;
      events: BatonEvent[];
    };

/**
 * One row per event, except that consecutive subagent (sidechain) events from
 * the same agent fold into one group row (spec: "Subagent (sidechain) events").
 */
export function buildFeedRows(events: readonly BatonEvent[]): FeedRow[] {
  const rows: FeedRow[] = [];
  for (const event of events) {
    if (!metaBool(event, "sidechain")) {
      rows.push({ type: "event", key: event.id, event });
      continue;
    }
    const agentId = metaString(event, "agentId");
    const prev = rows.at(-1);
    if (prev?.type === "sidechain" && prev.agentId === agentId) {
      prev.events.push(event);
    } else {
      rows.push({ type: "sidechain", key: `sidechain:${event.id}`, agentId, events: [event] });
    }
  }
  return rows;
}
