import type { SessionInfo } from "@baton/core";
import { useEffect, useState } from "react";
import { fetchSessions } from "../lib/sessions.js";

export type SessionsState = {
  sessions: SessionInfo[];
  error?: string;
  loaded: boolean;
};

/**
 * Polls `GET /sessions`. `refreshKey` triggers an extra fetch, e.g. when the
 * socket reports a session the list doesn't have yet.
 */
export function useSessions(refreshKey: string, intervalMs = 5000): SessionsState {
  const [state, setState] = useState<SessionsState>({ sessions: [], loaded: false });
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey only forces a refetch.
  useEffect(() => {
    const controller = new AbortController();
    const load = () =>
      fetchSessions(controller.signal).then(
        (sessions) => setState({ sessions, loaded: true }),
        (err: unknown) => {
          if (controller.signal.aborted) return;
          const error = err instanceof Error ? err.message : String(err);
          setState((s) => ({ ...s, loaded: true, error }));
        },
      );
    void load();
    const timer = setInterval(load, intervalMs);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [refreshKey, intervalMs]);
  return state;
}
