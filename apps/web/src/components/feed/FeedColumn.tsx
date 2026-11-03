import type { SessionInfo } from "@baton/core";
import { useState } from "react";
import { useSessionEvents } from "../../hooks/useStore.js";
import type { EventStore } from "../../lib/event-store.js";
import { AgentIcon } from "../AgentIcon.js";
import { LiveDot } from "../LiveDot.js";
import { ChatHandoffBubble } from "./ChatHandoffBubble.js";
import { Feed } from "./Feed.js";

type Props = {
  store: EventStore;
  sessionId: string;
  info: SessionInfo | undefined;
  live: boolean;
  onClose(): void;
  /** Removes the session from the hub for everyone. */
  onDelete?(): Promise<void>;
};

/** One session's header and feed. */
export function FeedColumn({ store, sessionId, info, live, onClose, onDelete }: Props) {
  const events = useSessionEvents(store, sessionId);
  const name = info?.projectName ?? events[0]?.projectPath ?? sessionId;
  const agent = info?.agent ?? events[0]?.agent ?? "claude-code";
  const [confirming, setConfirming] = useState(false);
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined);
  return (
    <section className="column" aria-label={`Session ${name}`}>
      <header className="column-head">
        <LiveDot live={live} />
        <AgentIcon agent={agent} />
        <div className="column-title">
          <h2>{name}</h2>
          <span className="column-sub" title={sessionId}>
            {sessionId.slice(0, 8)} · {events.length} events
          </span>
        </div>
        {onDelete &&
          (confirming ? (
            <fieldset className="column-confirm" aria-label="Delete this session for everyone?">
              <button
                type="button"
                className="note-btn is-danger"
                onClick={() => {
                  onDelete().catch((err: unknown) =>
                    setDeleteError(err instanceof Error ? err.message : String(err)),
                  );
                }}
              >
                Delete for everyone
              </button>
              <button type="button" className="note-btn" onClick={() => setConfirming(false)}>
                Keep
              </button>
            </fieldset>
          ) : (
            <button
              type="button"
              className="icon-btn"
              aria-label="Delete session"
              title="Delete this session from the team server, for everyone"
              onClick={() => setConfirming(true)}
            >
              🗑
            </button>
          ))}
        <button type="button" className="icon-btn" aria-label="Close panel" onClick={onClose}>
          ✕
        </button>
      </header>
      {deleteError && (
        <p className="canvas-error" role="alert">
          {deleteError}
        </p>
      )}
      <Feed events={events} />
      <footer className="column-foot">
        <ChatHandoffBubble sessionId={sessionId} events={events.length} />
      </footer>
    </section>
  );
}
