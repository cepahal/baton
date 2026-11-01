import type { BatonEvent } from "@baton/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { buildFeedRows, type FeedRow } from "../../lib/feed-rows.js";
import { EventCard } from "../events/EventCard.js";
import { SidechainGroup } from "../events/SidechainGroup.js";

/** How close to the bottom (px) still counts as "following" the feed. */
const FOLLOW_THRESHOLD = 48;

type Props = { events: readonly BatonEvent[] };

/**
 * A virtualized, scrolling list of events. Follows new events while the user
 * is at the bottom; scrolling up pauses that and offers "jump to latest".
 */
export function Feed({ events }: Props) {
  const rows = useMemo(() => buildFeedRows(events), [events]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);
  const [unseen, setUnseen] = useState(0);
  const lastCount = useRef(rows.length);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => estimate(rows[i]),
    getItemKey: (i) => rows[i]?.key ?? i,
    overscan: 8,
    paddingStart: 12,
    paddingEnd: 12,
  });

  const setFollow = useCallback((value: boolean) => {
    followingRef.current = value;
    setFollowing(value);
    if (value) setUnseen(0);
  }, []);

  const scrollToEnd = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // New rows: stick to the bottom while following, otherwise count them.
  useLayoutEffect(() => {
    const added = rows.length - lastCount.current;
    lastCount.current = rows.length;
    if (followingRef.current) {
      if (rows.length > 0) virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
    } else if (added > 0) {
      setUnseen((n) => n + added);
    }
  }, [rows.length, virtualizer]);

  // Rows measured taller than estimated push the end down; keep up with it.
  const totalSize = virtualizer.getTotalSize();
  useEffect(() => {
    if (followingRef.current && totalSize > 0) scrollToEnd();
  }, [totalSize, scrollToEnd]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_THRESHOLD;
    if (atBottom !== followingRef.current) setFollow(atBottom);
  };

  const jump = () => {
    setFollow(true);
    if (rows.length > 0) virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
    requestAnimationFrame(scrollToEnd);
  };

  return (
    <div className="feed">
      <div className="feed-scroll" ref={scrollRef} onScroll={onScroll}>
        {rows.length === 0 && <p className="feed-empty">Waiting for events…</p>}
        <div className="feed-inner" style={{ height: totalSize }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            if (!row) return null;
            return (
              <div
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                className="feed-row"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <Row row={row} />
              </div>
            );
          })}
        </div>
      </div>
      {!following && (
        <button type="button" className="jump" onClick={jump}>
          ↓ Jump to latest{unseen > 0 ? ` · ${unseen} new` : ""}
        </button>
      )}
    </div>
  );
}

function Row({ row }: { row: FeedRow }) {
  return row.type === "event" ? (
    <EventCard event={row.event} />
  ) : (
    <SidechainGroup agentId={row.agentId} events={row.events} />
  );
}

function estimate(row: FeedRow | undefined): number {
  if (!row || row.type === "sidechain") return 44;
  switch (row.event.kind) {
    case "tool_call":
    case "tool_result":
    case "system":
    case "session_start":
      return 34;
    case "thinking":
      return 44;
    default:
      return Math.min(600, 64 + Math.ceil(row.event.text.length / 60) * 20);
  }
}
