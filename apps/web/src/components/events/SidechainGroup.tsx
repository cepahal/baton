import type { BatonEvent } from "@baton/core";
import { useState } from "react";
import { Caret, EventCard } from "./EventCard.js";

type Props = { agentId: string | undefined; events: readonly BatonEvent[] };

/** A subagent's run of events, collapsed by default. */
export function SidechainGroup({ agentId, events }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <section className="ev ev-sidechain">
      <button
        type="button"
        className="ev-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Caret open={open} />
        Subagent{agentId ? ` ${agentId.slice(0, 8)}` : ""} · {events.length} event
        {events.length === 1 ? "" : "s"}
      </button>
      {open && (
        <div className="sidechain-body">
          {events.map((e) => (
            <EventCard key={e.id} event={e} />
          ))}
        </div>
      )}
    </section>
  );
}
