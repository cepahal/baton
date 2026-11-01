import type { SessionInfo } from "@baton/core";
import { useSessionEvents } from "../../hooks/useStore.js";
import type { EventStore } from "../../lib/event-store.js";
import { LiveDot } from "../LiveDot.js";
import { Feed } from "./Feed.js";

type Props = {
  store: EventStore;
  sessionId: string;
  info: SessionInfo | undefined;
  live: boolean;
  onClose(): void;
};

/** One session's header and feed. */
export function FeedColumn({ store, sessionId, info, live, onClose }: Props) {
  const events = useSessionEvents(store, sessionId);
  const name = info?.projectName ?? events[0]?.projectPath ?? sessionId;
  return (
    <section className="column" aria-label={`Session ${name}`}>
      <header className="column-head">
        <LiveDot live={live} />
        <div className="column-title">
          <h2>{name}</h2>
          <span className="column-sub" title={sessionId}>
            {sessionId.slice(0, 8)} · {events.length} events
          </span>
        </div>
        <button type="button" className="icon-btn" aria-label="Close column" onClick={onClose}>
          ✕
        </button>
      </header>
      <Feed events={events} />
    </section>
  );
}
