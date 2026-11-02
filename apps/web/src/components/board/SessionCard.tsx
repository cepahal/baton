import type { SessionInfo } from "@baton/core";
import { useMemo } from "react";
import { useSessionEvents } from "../../hooks/useStore.js";
import type { EventStore } from "../../lib/event-store.js";
import { summarize } from "../../lib/summary.js";
import { formatAgo } from "../../lib/time.js";
import { AgentIcon } from "../AgentIcon.js";
import { LiveDot } from "../LiveDot.js";

type Props = {
  store: EventStore;
  sessionId: string;
  info: SessionInfo | undefined;
  live: boolean;
  now: number;
  open: boolean;
  onOpen(): void;
};

/** A session pinned to the board: name, owner and a summary. Click to open; drag off the board to remove. */
export function SessionCard({ store, sessionId, info, live, now, open, onOpen }: Props) {
  const events = useSessionEvents(store, sessionId);
  const summary = useMemo(() => summarize(events), [events]);
  const name = info?.projectName ?? events[0]?.projectPath ?? sessionId;
  const owner = info?.source ?? "local";
  const agent = info?.agent ?? events[0]?.agent ?? "claude-code";
  return (
    <article className={`card${open ? " is-open" : ""}`} aria-label={`Session ${name}`}>
      <button
        type="button"
        className="card-body"
        aria-expanded={open}
        title={info?.projectPath ?? sessionId}
        onClick={onOpen}
      >
        <span className="card-head">
          <LiveDot live={live} />
          <AgentIcon agent={agent} />
          <span className="card-name">{name}</span>
        </span>
        <span className="card-owner">
          <span className="card-owner-orb" aria-hidden>
            {owner.slice(0, 1).toUpperCase()}
          </span>
          {owner}
        </span>
        <span className="card-summary">
          {summary.topic ? (
            <>
              <span className="card-label">Asked</span>
              <span className="card-text">{summary.topic}</span>
            </>
          ) : (
            <span className="card-text is-faint">No prompts yet.</span>
          )}
          {summary.latest && (
            <>
              <span className="card-label">Latest</span>
              <span className="card-text">{summary.latest}</span>
            </>
          )}
        </span>
        <span className="card-foot">
          {summary.prompts} prompts · {summary.toolCalls} tools · {events.length} events
          {info && <> · {formatAgo(Date.parse(info.lastActivity), now)}</>}
        </span>
      </button>
    </article>
  );
}
