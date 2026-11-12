import type { SessionInfo } from "@baton/core";
import wordmark from "../assets/baton-wordmark.png";
import type { ConnectionState } from "../lib/connection.js";
import { SESSION_DRAG_TYPE } from "../lib/drag.js";
import { groupBySource } from "../lib/session-groups.js";
import { formatAgo, isLive } from "../lib/time.js";
import { AgentIcon } from "./AgentIcon.js";
import { ConnectionBadge } from "./ConnectionBadge.js";
import { LiveDot } from "./LiveDot.js";

type Props = {
  sessions: SessionInfo[];
  error: string | undefined;
  loaded: boolean;
  /** Sessions already on the canvas. */
  onCanvas: readonly string[];
  now: number;
  connection: ConnectionState;
  onRetry(): void;
};

export function Sidebar(props: Props) {
  const { sessions, onCanvas, now } = props;
  return (
    <aside className="sidebar">
      <div className="brand">
        <h1>
          <img className="brand-logo" src={wordmark} alt="Baton" />
        </h1>
      </div>
      <ConnectionBadge state={props.connection} now={now} onRetry={props.onRetry} />
      <h2 className="sidebar-heading">
        Sessions <span className="count">{sessions.length}</span>
      </h2>
      {props.error && <p className="sidebar-note is-error">{props.error}</p>}
      {props.loaded && sessions.length === 0 && !props.error && (
        <p className="sidebar-note">
          No sessions yet. Start Claude Code, Codex or Cursor anywhere and it shows up here.
        </p>
      )}
      <div className="session-groups">
        {groupBySource(sessions).map((group) => (
          <section
            key={group.source ?? ""}
            className="session-group"
            aria-label={group.source ?? "Sessions"}
          >
            {group.source !== undefined && (
              <h3 className="session-group-heading">
                <span className="session-group-name">{group.source}</span>
                <span className="count">{group.sessions.length}</span>
              </h3>
            )}
            <ul className="session-list">
              {group.sessions.map((s) => {
                const placed = onCanvas.includes(s.sessionId);
                const last = Date.parse(s.lastActivity);
                return (
                  // Drag-only: dropping on the canvas places it; clicking does nothing.
                  <li
                    key={s.sessionId}
                    className={`session${placed ? " is-selected" : ""}`}
                    title={`${s.projectPath}\nDrag onto the canvas${placed ? " (already there)" : ""}`}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(SESSION_DRAG_TYPE, s.sessionId);
                      e.dataTransfer.effectAllowed = "copy";
                    }}
                  >
                    <LiveDot live={isLive(s.lastActivity, now)} />
                    <AgentIcon agent={s.agent} />
                    <span className="session-text">
                      <span className="session-name">{s.projectName}</span>
                      <span className="session-meta">
                        {formatAgo(last, now)} · {s.events} events · {s.sessionId.slice(0, 6)}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
      <footer className="sidebar-foot">
        <a
          className="report-link"
          href={reportUrl(globalThis.location)}
          target="_blank"
          rel="noopener noreferrer"
        >
          Report issue
        </a>
      </footer>
    </aside>
  );
}

/**
 * The "Report issue" page is served by this machine's own daemon, never the
 * team server, so logs stay local. Viewing a local daemon it's on this page's
 * origin; viewing a team server it's the local daemon's default port.
 */
export function reportUrl(location: Pick<Location, "hostname" | "origin"> | undefined): string {
  const host = location?.hostname ?? "";
  const local = host === "127.0.0.1" || host === "localhost" || host === "[::1]";
  return local && location ? `${location.origin}/report` : "http://127.0.0.1:7777/report";
}
