import type { SessionInfo } from "@baton/core";

export type SessionGroup = {
  /** Daemon name, or undefined for sessions without one (a local daemon). */
  source: string | undefined;
  sessions: SessionInfo[];
};

/**
 * Groups sessions by the daemon they stream from, keeping the incoming order
 * (most recent first) both inside each group and between groups: a group sits
 * where its most recent session would. A local daemon's sessions have no
 * source and come back as one group.
 */
export function groupBySource(sessions: readonly SessionInfo[]): SessionGroup[] {
  const groups = new Map<string | undefined, SessionGroup>();
  for (const session of sessions) {
    let group = groups.get(session.source);
    if (!group) {
      group = { source: session.source, sessions: [] };
      groups.set(session.source, group);
    }
    group.sessions.push(session);
  }
  return [...groups.values()];
}
