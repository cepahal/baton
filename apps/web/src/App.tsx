import { useCallback, useEffect, useMemo, useState } from "react";
import { Board } from "./components/board/Board.js";
import { SessionCard } from "./components/board/SessionCard.js";
import { FeedColumn } from "./components/feed/FeedColumn.js";
import { Sidebar } from "./components/Sidebar.js";
import { useConnection } from "./hooks/useConnection.js";
import { useNow } from "./hooks/useNow.js";
import { usePositions } from "./hooks/usePositions.js";
import { useSelection } from "./hooks/useSelection.js";
import { useSessions } from "./hooks/useSessions.js";
import { useStoreSessionIds } from "./hooks/useStore.js";
import { EventStore } from "./lib/event-store.js";
import { CARD_W, GRID, layout, type Point } from "./lib/positions.js";
import { defaultSelection } from "./lib/selection.js";
import { isLive } from "./lib/time.js";

const MAX_CARDS = 12;

export function App() {
  // Batch store notifications: a replay of thousands of events renders once per frame.
  const [store] = useState(() => new EventStore({ schedule: (flush) => setTimeout(flush, 16) }));
  const connection = useConnection(store);
  const seenIds = useStoreSessionIds(store);
  const sessionsState = useSessions(seenIds);
  const { sessions: unsorted, error, loaded } = sessionsState;
  const now = useNow(1000);
  const sessions = useMemo(
    () => [...unsorted].sort((a, b) => b.lastActivity.localeCompare(a.lastActivity)),
    [unsorted],
  );
  const { selected, toggle, add, remove, initialize } = useSelection(MAX_CARDS);
  const [openId, setOpenId] = useState<string | undefined>(undefined);
  const { positions: saved, move, forget } = usePositions();
  const [boardWidth, setBoardWidth] = useState(0);
  const columns = Math.floor((boardWidth - GRID) / (CARD_W + GRID));
  const positions = useMemo(() => layout(selected, saved, columns), [selected, saved, columns]);

  const dropSession = useCallback(
    (id: string, at: Point) => {
      add(id);
      move(id, at);
    },
    [add, move],
  );
  const removeCard = useCallback(
    (id: string) => {
      remove(id);
      forget(id);
    },
    [remove, forget],
  );

  // First visit: pin the sessions that are live right now.
  useEffect(() => {
    const ids = defaultSelection(sessionsState, Date.now(), MAX_CARDS);
    if (ids) initialize(ids);
  }, [sessionsState, initialize]);

  // A card taken off the board closes its panel.
  const shownId = openId !== undefined && selected.includes(openId) ? openId : undefined;

  const byId = useMemo(() => new Map(sessions.map((s) => [s.sessionId, s])), [sessions]);
  const openInfo = shownId === undefined ? undefined : byId.get(shownId);

  return (
    <div className={`app${shownId ? " has-panel" : ""}`}>
      <Sidebar
        sessions={sessions}
        error={error}
        loaded={loaded}
        selected={selected}
        maxSelected={MAX_CARDS}
        now={now}
        connection={connection.state}
        onRetry={connection.retryNow}
        onToggle={toggle}
      />
      <Board
        ids={selected}
        positions={positions}
        max={MAX_CARDS}
        full={selected.length >= MAX_CARDS}
        onDropSession={dropSession}
        onMoveCard={move}
        onRemoveCard={removeCard}
        onWidth={setBoardWidth}
        renderCard={(id) => {
          const info = byId.get(id);
          return (
            <SessionCard
              store={store}
              sessionId={id}
              info={info}
              live={info ? isLive(info.lastActivity, now) : false}
              now={now}
              open={id === shownId}
              onOpen={() => setOpenId(id === shownId ? undefined : id)}
            />
          );
        }}
      />
      {shownId !== undefined && (
        <aside className="panel">
          <FeedColumn
            key={shownId}
            store={store}
            sessionId={shownId}
            info={openInfo}
            live={openInfo ? isLive(openInfo.lastActivity, now) : false}
            onClose={() => setOpenId(undefined)}
          />
        </aside>
      )}
    </div>
  );
}
