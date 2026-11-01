import { useEffect, useState, useSyncExternalStore } from "react";
import { ConnectionManager, type ConnectionState } from "../lib/connection.js";
import type { EventStore } from "../lib/event-store.js";
import { defaultSocketUrl } from "../lib/sessions.js";

export type Connection = {
  state: ConnectionState;
  retryNow(): void;
};

/**
 * The app's single WebSocket to the hub. Every event goes into `store`;
 * components read events from the store, not from here.
 */
export function useConnection(
  store: EventStore,
  url = defaultSocketUrl(window.location),
): Connection {
  const [manager] = useState(
    () => new ConnectionManager({ url, onEvent: (message) => store.add(message.event) }),
  );
  useEffect(() => {
    manager.start();
    return () => manager.stop();
  }, [manager]);
  const state = useSyncExternalStore(manager.subscribe, manager.getState);
  return { state, retryNow: () => manager.retryNow() };
}
