import type { CanvasMessage, HandoffMessage, NotesMessage } from "@baton/core";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
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
  onCanvas?: (message: CanvasMessage) => void,
  onHandoff?: (message: HandoffMessage) => void,
  onNotes?: (message: NotesMessage) => void,
  url = defaultSocketUrl(window.location),
): Connection {
  // The socket outlives renders; it reaches the latest canvas handler through a ref.
  const canvasRef = useRef(onCanvas);
  canvasRef.current = onCanvas;
  const handoffRef = useRef(onHandoff);
  handoffRef.current = onHandoff;
  const notesRef = useRef(onNotes);
  notesRef.current = onNotes;
  const [manager] = useState(
    () =>
      new ConnectionManager({
        url,
        onEvent: (message) => store.add(message.event),
        onCanvas: (message) => canvasRef.current?.(message),
        onHandoff: (message) => handoffRef.current?.(message),
        onNotes: (message) => notesRef.current?.(message),
        onSessionRemoved: (message) => store.remove(message.sessionId),
      }),
  );
  useEffect(() => {
    manager.start();
    return () => manager.stop();
  }, [manager]);
  const state = useSyncExternalStore(manager.subscribe, manager.getState);
  return { state, retryNow: () => manager.retryNow() };
}
