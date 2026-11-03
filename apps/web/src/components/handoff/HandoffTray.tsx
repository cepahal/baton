import type { Handoff, HandoffKind } from "@baton/core";
import { useState } from "react";
import { HANDOFF_KIND_NAMES } from "../../lib/drag.js";
import type { InboxEntry } from "../../lib/handoff-api.js";
import { formatAgo } from "../../lib/time.js";

type Props = {
  handoffs: readonly Handoff[];
  inbox: readonly InboxEntry[];
  now: number;
};

/** Most handoffs listed. */
const SHOWN = 8;

/**
 * Handoff status, live: what was sent and what the receiver decided, plus
 * offers waiting on this machine with a link to their confirm page.
 */
export function HandoffTray({ handoffs, inbox, now }: Props) {
  const [open, setOpen] = useState(true);
  const waiting = inbox.filter((o) => o.status === "pending");
  if (handoffs.length === 0 && waiting.length === 0) return null;
  return (
    <section className={`handoff-tray${open ? "" : " is-closed"}`} aria-label="Handoffs">
      <button type="button" className="handoff-tray-head" onClick={() => setOpen((o) => !o)}>
        Handoffs
        {waiting.length > 0 && <span className="handoff-count">{waiting.length} for you</span>}
        <span aria-hidden>{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <ul>
          {waiting.map((o) => (
            <li key={`in-${o.id}`} className="handoff-item is-incoming">
              <span>
                <b>{o.sender}</b> sent you a {kindName(o.kind)}
              </span>
              <a href={o.url} target="_blank" rel="noopener">
                Review
              </a>
            </li>
          ))}
          {handoffs.slice(0, SHOWN).map((h) => (
            <li key={h.id} className="handoff-item">
              <span>
                <b>{h.sender}</b> → {h.to.user ?? "teammate"}{" "}
                <span className="is-faint">
                  {kindName(h.kind)} · {formatAgo(Date.parse(h.updatedAt), now)}
                </span>
              </span>
              <span className={`handoff-status is-${h.status}`}>{h.status}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The tray's list comes from the daemon as a plain string; unknown kinds show as-is. */
function kindName(kind: string): string {
  return kind in HANDOFF_KIND_NAMES ? HANDOFF_KIND_NAMES[kind as HandoffKind] : kind;
}
