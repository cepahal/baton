import type { CanvasPoint, DomainLabel } from "@baton/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Canvas } from "./components/canvas/Canvas.js";
import { NotePreview } from "./components/canvas/NotePreview.js";
import { FeedColumn } from "./components/feed/FeedColumn.js";
import { HandoffDialog } from "./components/handoff/HandoffDialog.js";
import { HandoffTray } from "./components/handoff/HandoffTray.js";
import { Sidebar } from "./components/Sidebar.js";
import { useCanvasPositions } from "./hooks/useCanvasPositions.js";
import { useConnection } from "./hooks/useConnection.js";
import { useHandoffs } from "./hooks/useHandoffs.js";
import { useNotes } from "./hooks/useNotes.js";
import { useNow } from "./hooks/useNow.js";
import { useSessions } from "./hooks/useSessions.js";
import { useStoreSessionIds } from "./hooks/useStore.js";
import { saveDomain } from "./lib/canvas-api.js";
import { buildCanvas, cardKey, dedupe, placeDrop } from "./lib/canvas-model.js";
import type { HandoffDrag } from "./lib/drag.js";
import { EventStore } from "./lib/event-store.js";
import { loadSender } from "./lib/handoff-api.js";
import { randomNoteColor } from "./lib/notes-api.js";
import { deleteSession } from "./lib/sessions.js";
import { isLive } from "./lib/time.js";

export function App() {
  // Batch store notifications: a replay of thousands of events renders once per frame.
  const [store] = useState(() => new EventStore({ schedule: (flush) => setTimeout(flush, 16) }));
  const canvas = useCanvasPositions();
  const [live, setLive] = useState(false);
  const handoffs = useHandoffs(live);
  const notes = useNotes();
  const connection = useConnection(store, canvas.onMessage, handoffs.onMessage, notes.onMessage);
  const socketOpen = connection.state.status === "open";
  useEffect(() => setLive(socketOpen), [socketOpen]);
  const seenIds = useStoreSessionIds(store);
  const [refresh, setRefresh] = useState(0);
  const sessionsState = useSessions(`${seenIds}|${refresh}`);
  const { sessions: listed, error, loaded } = sessionsState;
  const now = useNow(1000);
  // One entry per session, newest activity first.
  const sessions = useMemo(
    () => dedupe(listed).sort((a, b) => b.lastActivity.localeCompare(a.lastActivity)),
    [listed],
  );
  const [openId, setOpenId] = useState<string | undefined>(undefined);

  const byId = useMemo(() => new Map(sessions.map((s) => [s.sessionId, s])), [sessions]);
  // The canvas is shared: a session is on it when the team has placed it.
  const model = useMemo(
    () => buildCanvas(sessions, canvas.positions),
    [sessions, canvas.positions],
  );
  const onCanvas = useMemo(
    () => model.groups.flatMap((g) => g.cards.map((c) => c.session.sessionId)),
    [model],
  );

  const { move, remove } = canvas;
  const drop = useCallback(
    (id: string, point: CanvasPoint) => {
      const session = byId.get(id);
      if (session) move({ [cardKey(id)]: placeDrop(session, point, model) });
    },
    [byId, model, move],
  );
  const open = useCallback((id: string) => setOpenId((cur) => (cur === id ? undefined : id)), []);
  const removeCard = useCallback(
    (id: string) => {
      remove([cardKey(id)]);
      setOpenId((cur) => (cur === id ? undefined : cur));
    },
    [remove],
  );
  const [domainError, setDomainError] = useState<string | undefined>(undefined);
  const setDomain = useCallback((id: string, label: DomainLabel | null) => {
    saveDomain({ sessionId: id }, label).then(
      () => {
        setDomainError(undefined);
        setRefresh((n) => n + 1);
      },
      (err: unknown) => setDomainError(err instanceof Error ? err.message : String(err)),
    );
  }, []);

  const [composing, setComposing] = useState<{ drag: HandoffDrag; to: string } | undefined>(
    undefined,
  );
  const startHandoff = useCallback(
    (drag: HandoffDrag, to: string) => setComposing({ drag, to }),
    [],
  );

  const [previewId, setPreviewId] = useState<string | undefined>(undefined);
  const previewing = notes.notes.find((n) => n.id === previewId);
  const { create: createNote, update: updateNote, attach: attachNote } = notes;
  const noteCreate = useCallback(
    (point: CanvasPoint, files?: File[]) => {
      const author = loadSender(browserStorage());
      void createNote({
        x: point.x,
        y: point.y,
        color: randomNoteColor(),
        ...(author ? { author } : {}),
      }).then((note) => {
        if (note && files && files.length > 0) void attachNote(note.id, files);
      });
    },
    [createNote, attachNote],
  );
  const noteMove = useCallback(
    (id: string, p: CanvasPoint) => updateNote(id, { x: p.x, y: p.y }),
    [updateNote],
  );
  const noteText = useCallback(
    (id: string, text: string) => updateNote(id, { text }),
    [updateNote],
  );
  const noteFiles = useCallback(
    (id: string, files: File[]) => void attachNote(id, files),
    [attachNote],
  );

  // A card taken off the canvas closes its panel.
  const shownId = openId !== undefined && onCanvas.includes(openId) ? openId : undefined;
  const openInfo = shownId === undefined ? undefined : byId.get(shownId);
  const problem = canvas.error ?? domainError ?? notes.error;

  return (
    <div className={`app${shownId ? " has-panel" : ""}`}>
      <Sidebar
        sessions={sessions}
        error={error}
        loaded={loaded}
        onCanvas={onCanvas}
        now={now}
        connection={connection.state}
        onRetry={connection.retryNow}
      />
      <Canvas
        model={model}
        now={now}
        openId={shownId}
        onOpen={open}
        onRemove={removeCard}
        onDomain={setDomain}
        onMove={move}
        onDropSession={drop}
        onHandoff={startHandoff}
        notes={notes.notes}
        onNoteCreate={noteCreate}
        onNoteMove={noteMove}
        onNoteText={noteText}
        onNoteFiles={noteFiles}
        onNotePreview={setPreviewId}
      />
      {previewing && (
        <NotePreview
          key={previewing.id}
          note={previewing}
          onText={(text) => updateNote(previewing.id, { text })}
          onColor={(color) => updateNote(previewing.id, { color })}
          onFiles={(files) => void attachNote(previewing.id, files)}
          onRemoveFile={(f) =>
            updateNote(previewing.id, {
              files: previewing.files.filter((x) => !(x.sha256 === f.sha256 && x.name === f.name)),
            })
          }
          onDelete={() => {
            notes.remove(previewing.id);
            setPreviewId(undefined);
          }}
          onClose={() => setPreviewId(undefined)}
        />
      )}
      <HandoffTray handoffs={handoffs.handoffs} inbox={handoffs.inbox} now={now} />
      {composing && (
        <HandoffDialog
          drag={composing.drag}
          from={byId.get(composing.drag.sessionId)}
          to={byId.get(composing.to)}
          onSent={(h) => {
            handoffs.added(h);
            setComposing(undefined);
          }}
          onClose={() => setComposing(undefined)}
        />
      )}
      {problem && (
        <p className="canvas-error" role="alert">
          {problem}
        </p>
      )}
      {shownId !== undefined && (
        <aside className="panel">
          <FeedColumn
            key={shownId}
            store={store}
            sessionId={shownId}
            info={openInfo}
            live={openInfo ? isLive(openInfo.lastActivity, now) : false}
            onClose={() => setOpenId(undefined)}
            onDelete={async () => {
              await deleteSession(shownId);
              store.remove(shownId);
              setOpenId(undefined);
              setRefresh((r) => r + 1);
            }}
          />
        </aside>
      )}
    </div>
  );
}

function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
