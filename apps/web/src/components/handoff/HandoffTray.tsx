import type { Handoff, MeResponse } from "@baton/core";
import { useState } from "react";
import { HANDOFF_KIND_NAMES } from "../../lib/drag.js";
import { isForMe } from "../../lib/handoff-api.js";
import { formatAgo } from "../../lib/time.js";

type Props = {
  handoffs: readonly Handoff[];
  me: MeResponse | undefined;
  now: number;
};

/** Most handoffs listed. */
const SHOWN = 8;

/**
 * Handoff status, live. "For you" lists the pending handoffs this browser can
 * answer (it is paired with the receiving machine, or it is the local viewer),
 * each linking to its page with Accept / Decline.
 */
export function HandoffTray({ handoffs, me, now }: Props) {
  const [open, setOpen] = useState(true);
  const waiting = handoffs.filter((h) => h.status === "pending" && isForMe(h, me));
  const unpaired = me !== undefined && !me.local && me.pairing === null;
  if (handoffs.length === 0) return null;
  return (
    <section className={`handoff-tray${open ? "" : " is-closed"}`} aria-label="Handoffs">
      <button type="button" className="handoff-tray-head" onClick={() => setOpen((o) => !o)}>
        Handoffs
        {waiting.length > 0 && <span className="handoff-count">{waiting.length} for you</span>}
        <span aria-hidden>{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <ul>
          {waiting.map((h) => (
            <li key={`in-${h.id}`} className="handoff-item is-incoming">
              <span>
                <b>{h.sender}</b> sent you a {HANDOFF_KIND_NAMES[h.kind]}
              </span>
              <a href={`/handoffs/${h.id}`}>Review</a>
            </li>
          ))}
          {handoffs.slice(0, SHOWN).map((h) => (
            <li key={h.id} className="handoff-item">
              <span>
                <b>{h.sender}</b> → {h.to.user ?? h.to.daemon ?? "teammate"}{" "}
                <span className="is-faint">
                  {HANDOFF_KIND_NAMES[h.kind]} · {formatAgo(Date.parse(h.updatedAt), now)}
                </span>
              </span>
              <a className={`handoff-status is-${h.status}`} href={`/handoffs/${h.id}`}>
                {h.status}
              </a>
            </li>
          ))}
          {unpaired && (
            <li className="handoff-item is-hint">
              <span className="is-faint">
                To answer handoffs sent to you, pair this browser: run <code>baton pair</code> on
                your machine and open its link.
              </span>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}
