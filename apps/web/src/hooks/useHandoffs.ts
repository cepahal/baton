import type { Handoff, HandoffMessage } from "@baton/core";
import { useCallback, useEffect, useState } from "react";
import { fetchHandoffs, mergeHandoffs } from "../lib/handoff-api.js";

export type Handoffs = {
  handoffs: Handoff[];
  onMessage(message: HandoffMessage): void;
  added(handoff: Handoff): void;
};

/** Every handoff the hub knows, kept live by `handoff` messages on the socket. */
export function useHandoffs(live: boolean): Handoffs {
  const [handoffs, setHandoffs] = useState<Handoff[]>([]);

  // On load and on each (re)connect: updates sent while the socket was down are missed.
  useEffect(() => {
    if (!live) return;
    const abort = new AbortController();
    fetchHandoffs(abort.signal).then(
      (list) => setHandoffs((cur) => list.reduce(mergeHandoffs, cur)),
      () => undefined,
    );
    return () => abort.abort();
  }, [live]);

  const onMessage = useCallback((message: HandoffMessage) => {
    setHandoffs((cur) => mergeHandoffs(cur, message.handoff));
  }, []);
  const added = useCallback((handoff: Handoff) => {
    setHandoffs((cur) => mergeHandoffs(cur, handoff));
  }, []);
  return { handoffs, onMessage, added };
}
