import type { ConnectionState } from "../lib/connection.js";

type Props = { state: ConnectionState; now: number; onRetry(): void };

export function ConnectionBadge({ state, now, onRetry }: Props) {
  const label = describe(state, now);
  return (
    <div className={`conn conn-${state.status}`} role="status" aria-live="polite">
      <span className="conn-light" aria-hidden />
      <span className="conn-label">{label}</span>
      {state.status === "reconnecting" && (
        <button type="button" className="conn-retry" onClick={onRetry}>
          Retry
        </button>
      )}
      {state.gaps > 0 && (
        <span className="conn-gaps" title="The daemon dropped events before this viewer got them">
          {state.gaps} gap{state.gaps === 1 ? "" : "s"}
        </span>
      )}
    </div>
  );
}

function describe(state: ConnectionState, now: number): string {
  switch (state.status) {
    case "open":
      return "Connected";
    case "connecting":
      return "Connecting…";
    case "stopped":
      return "Disconnected";
    case "reconnecting": {
      if (state.retryAt === undefined) return "Reconnecting…";
      const s = Math.max(0, Math.ceil((state.retryAt - now) / 1000));
      return s > 0 ? `Reconnecting in ${s}s` : "Reconnecting…";
    }
  }
}
