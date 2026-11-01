import type { BatonEvent } from "@baton/core";
import { useCallback, useSyncExternalStore } from "react";
import type { EventStore } from "../lib/event-store.js";

/** A session's events; re-renders once per batch that touches the session. */
export function useSessionEvents(store: EventStore, sessionId: string): readonly BatonEvent[] {
  const subscribe = useCallback(
    (l: () => void) => store.subscribe(sessionId, l),
    [store, sessionId],
  );
  const get = useCallback(() => store.events(sessionId), [store, sessionId]);
  return useSyncExternalStore(subscribe, get);
}

/** Session ids seen on the socket (sorted for a stable snapshot). */
export function useStoreSessionIds(store: EventStore): string {
  const subscribe = useCallback((l: () => void) => store.subscribeSessions(l), [store]);
  const get = useCallback(() => store.sessionIds().sort().join("\n"), [store]);
  return useSyncExternalStore(subscribe, get);
}
