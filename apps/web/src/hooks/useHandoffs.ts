import type { Handoff, HandoffMessage } from "@baton/core";
import { useCallback, useEffect, useState } from "react";
import { fetchHandoffs, fetchInbox, type InboxEntry, mergeHandoffs } from "../lib/handoff-api.js";

export type Handoffs = {
  handoffs: Handoff[];
  /** Offers on this machine's inbox (local daemon only), with their confirm page links. */
  inbox: InboxEntry[];
  onMessage(message: HandoffMessage): void;
  added(handoff: Handoff): void;
};

/** Every handoff the hub knows, kept live by `handoff` messages on the socket. */
export function useHandoffs(live: boolean): Handoffs {
  const [handoffs, setHandoffs] = useState<Handoff[]>([]);
  const [inbox, setInbox] = useState<InboxEntry[]>([]);

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

  // The inbox has no push of its own: re-read it whenever a handoff changes.
  const refreshInbox = useCallback(() => {
    fetchInbox().then(setInbox, () => undefined);
  }, []);
  useEffect(refreshInbox, [refreshInbox]);

  const onMessage = useCallback(
    (message: HandoffMessage) => {
      setHandoffs((cur) => mergeHandoffs(cur, message.handoff));
      refreshInbox();
    },
    [refreshInbox],
  );
  const added = useCallback((handoff: Handoff) => {
    setHandoffs((cur) => mergeHandoffs(cur, handoff));
  }, []);
  return { handoffs, inbox, onMessage, added };
}
