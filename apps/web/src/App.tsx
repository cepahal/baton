import { useEffect, useMemo, useState } from "react";
import { FeedColumn } from "./components/feed/FeedColumn.js";
import { Sidebar } from "./components/Sidebar.js";
import { useConnection } from "./hooks/useConnection.js";
import { useNow } from "./hooks/useNow.js";
import { useSelection } from "./hooks/useSelection.js";
import { useSessions } from "./hooks/useSessions.js";
import { useStoreSessionIds } from "./hooks/useStore.js";
import { EventStore } from "./lib/event-store.js";
import { defaultSelection } from "./lib/selection.js";
import { isLive } from "./lib/time.js";

const MAX_COLUMNS = 3;

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
  const { selected, toggle, remove, initialize } = useSelection(MAX_COLUMNS);

  // First visit: open the sessions that are live right now.
  useEffect(() => {
    const ids = defaultSelection(sessionsState, Date.now(), MAX_COLUMNS);
    if (ids) initialize(ids);
  }, [sessionsState, initialize]);

  const byId = useMemo(() => new Map(sessions.map((s) => [s.sessionId, s])), [sessions]);

  return (
    <div className="app">
      <Sidebar
        sessions={sessions}
        error={error}
        loaded={loaded}
        selected={selected}
        maxSelected={MAX_COLUMNS}
        now={now}
        connection={connection.state}
        onRetry={connection.retryNow}
        onToggle={toggle}
      />
      <main className="columns" data-count={selected.length}>
        {selected.length === 0 ? (
          <div className="placeholder">
            <span className="brand-orb big" aria-hidden />
            <p>Pick up to {MAX_COLUMNS} sessions on the left to watch them live.</p>
          </div>
        ) : (
          selected.map((id) => {
            const info = byId.get(id);
            return (
              <FeedColumn
                key={id}
                store={store}
                sessionId={id}
                info={info}
                live={info ? isLive(info.lastActivity, now) : false}
                onClose={() => remove(id)}
              />
            );
          })
        )}
      </main>
    </div>
  );
}
