import type { SessionInfo } from "@baton/core";
import type { ConnectionState } from "../lib/connection.js";
import { formatAgo, isLive } from "../lib/time.js";
import { ConnectionBadge } from "./ConnectionBadge.js";
import { LiveDot } from "./LiveDot.js";

type Props = {
  sessions: SessionInfo[];
  error: string | undefined;
  loaded: boolean;
  selected: readonly string[];
  maxSelected: number;
  now: number;
  connection: ConnectionState;
  onRetry(): void;
  onToggle(sessionId: string): void;
};

export function Sidebar(props: Props) {
  const { sessions, selected, maxSelected, now } = props;
  const full = selected.length >= maxSelected;
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-orb" aria-hidden />
        <h1>Baton</h1>
      </div>
      <ConnectionBadge state={props.connection} now={now} onRetry={props.onRetry} />
      <h2 className="sidebar-heading">
        Sessions <span className="count">{sessions.length}</span>
      </h2>
      {props.error && <p className="sidebar-note is-error">{props.error}</p>}
      {props.loaded && sessions.length === 0 && !props.error && (
        <p className="sidebar-note">
          No sessions yet. Start Claude Code anywhere and it shows up here.
        </p>
      )}
      <ul className="session-list">
        {sessions.map((s) => {
          const isSelected = selected.includes(s.sessionId);
          const last = Date.parse(s.lastActivity);
          return (
            <li key={s.sessionId}>
              <button
                type="button"
                className={`session${isSelected ? " is-selected" : ""}`}
                aria-pressed={isSelected}
                disabled={!isSelected && full}
                title={full && !isSelected ? `Up to ${maxSelected} columns` : s.projectPath}
                onClick={() => props.onToggle(s.sessionId)}
              >
                <LiveDot live={isLive(s.lastActivity, now)} />
                <span className="session-text">
                  <span className="session-name">{s.projectName}</span>
                  <span className="session-meta">
                    {formatAgo(last, now)} · {s.events} events · {s.sessionId.slice(0, 6)}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
