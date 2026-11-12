import type { AgentId } from "@baton/core";

const LABELS: Record<AgentId, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
};

/** Display name of a coding agent. */
export const agentLabel = (agent: AgentId): string => LABELS[agent];

/** Spark: eight rounded rays. */
function Spark() {
  const rays = [0, 45, 90, 135];
  return (
    <g stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      {rays.map((deg) => (
        <line key={deg} x1="10" y1="3.5" x2="10" y2="16.5" transform={`rotate(${deg} 10 10)`} />
      ))}
    </g>
  );
}

/** Prompt: a chevron and a cursor bar. */
function Prompt() {
  return (
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4.5 6l4.5 4-4.5 4" />
      <path d="M11 14.5h5" />
    </g>
  );
}

/** Cursor arrow. */
function CursorMark() {
  return <path fill="currentColor" d="M4 2.5v15l4.2-4 2.7 5 2.5-1.4-2.7-5h5.8z" />;
}

/** Small badge showing which coding agent a session runs in. */
export function AgentIcon({ agent }: { agent: AgentId }) {
  const label = agentLabel(agent);
  return (
    <span className={`agent-icon agent-${agent}`} role="img" aria-label={label} title={label}>
      <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
        {agent === "codex" ? <Prompt /> : agent === "cursor" ? <CursorMark /> : <Spark />}
      </svg>
    </span>
  );
}
