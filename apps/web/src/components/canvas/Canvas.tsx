import type { CanvasPoint, CanvasPositions, DomainLabel, Note } from "@baton/core";
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  type Node,
  type NodeChange,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CanvasLink, CanvasModel } from "../../lib/canvas-model.js";
import { type HandoffDrag, SESSION_DRAG_TYPE } from "../../lib/drag.js";
import { LinkEdge, type LinkEdgeType } from "./LinkEdge.js";
import { NoteNode, type NoteNodeType } from "./NoteNode.js";
import { NOTE_PAD_DRAG_TYPE, NotePad } from "./NotePad.js";
import { RepoNode, type RepoNodeType } from "./RepoNode.js";
import { SessionNode, type SessionNodeType } from "./SessionNode.js";

type Props = {
  model: CanvasModel;
  now: number;
  openId: string | undefined;
  onOpen(sessionId: string): void;
  onRemove(sessionId: string): void;
  onDomain(sessionId: string, label: DomainLabel | null): void;
  /** Cards moved, by canvas key, at their new top-left corners. */
  onMove(moved: CanvasPositions): void;
  /** A session dragged in from the sidebar, dropped at `point` (canvas coordinates). */
  onDropSession(sessionId: string, point: CanvasPoint): void;
  /** A handoff (card grip or feed event) dropped on the card of `toSessionId`. */
  onHandoff(drag: HandoffDrag, toSessionId: string): void;
  /** The canvas's sticky notes, shared with everyone. */
  notes?: readonly Note[];
  /** A note pulled off the pad (or files dropped on bare canvas) at `point`. */
  onNoteCreate?(point: CanvasPoint, files?: File[]): void;
  onNoteMove?(id: string, point: CanvasPoint): void;
  onNoteText?(id: string, text: string): void;
  onNoteFiles?(id: string, files: File[]): void;
  onNotePreview?(id: string): void;
};

/** A note's size on the canvas; new notes are centred on where they're dropped. */
export const NOTE_SIZE = 180;

type CanvasNode = RepoNodeType | SessionNodeType | NoteNodeType;

const nodeTypes = { repo: RepoNode, session: SessionNode, note: NoteNode };
const edgeTypes = { link: LinkEdge };

/**
 * Links are orange; red (glowing, split in the middle) where two sessions
 * touched the same file, a possible merge conflict. Brighter when the same
 * lines were written.
 */
export const LINK_COLORS: Record<CanvasLink["level"], string> = {
  none: "#ff8a2b",
  file: "#ff3b4f",
  lines: "#ff1f3d",
};

/** Repo groups of session cards, the cards in each group linked together. */
export function Canvas(props: Props) {
  return (
    <ReactFlowProvider>
      <CanvasFlow {...props} />
    </ReactFlowProvider>
  );
}

function CanvasFlow(props: Props) {
  const { model, now, openId, onOpen, onRemove, onDomain, onMove, onDropSession, onHandoff } =
    props;
  const flow = useReactFlow<CanvasNode, LinkEdgeType>();
  const {
    notes = NO_NOTES,
    onNoteCreate,
    onNoteMove,
    onNoteText,
    onNoteFiles,
    onNotePreview,
  } = props;
  // The session card a dragged note is over: letting go there hands the note off.
  const [noteTarget, setNoteTarget] = useState<{ note: string; session: string } | undefined>(
    undefined,
  );
  const noteHandlers = useMemo(
    () => ({
      onText: (id: string, text: string) => onNoteText?.(id, text),
      onFiles: (id: string, files: File[]) => onNoteFiles?.(id, files),
      onPreview: (id: string) => onNotePreview?.(id),
    }),
    [onNoteText, onNoteFiles, onNotePreview],
  );
  const built = useMemo(
    () => [
      ...toNodes(
        model,
        { now, openId, onOpen, onRemove, onDomain, onHandoff },
        noteTarget?.session,
      ),
      ...toNoteNodes(notes, noteHandlers, noteTarget?.note),
    ],
    [model, now, openId, onOpen, onRemove, onDomain, onHandoff, notes, noteHandlers, noteTarget],
  );
  const [nodes, setNodes] = useState<CanvasNode[]>(built);
  // New data replaces the nodes, keeping what React Flow learnt about them.
  useEffect(() => setNodes((current) => mergeNodes(current, built)), [built]);

  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => setNodes((ns) => applyNodeChanges(changes, ns)),
    [],
  );
  /** The session card under a dragged note, if any. */
  const sessionUnder = useCallback(
    (node: Node): string | undefined => {
      const hit = flow
        .getIntersectingNodes(node)
        .find((n): n is SessionNodeType => n.type === "session");
      return hit?.data.card.session.sessionId;
    },
    [flow],
  );
  const onNodeDrag = useCallback(
    (_: unknown, node: Node) => {
      if (node.type !== "note") return;
      const session = sessionUnder(node);
      const noteId = noteIdOf(node.id);
      setNoteTarget((t) =>
        session === undefined
          ? undefined
          : t?.session === session && t.note === noteId
            ? t
            : { note: noteId, session },
      );
    },
    [sessionUnder],
  );
  const onNodeDragStop = useCallback(
    (_: unknown, node: Node, dragged: Node[]) => {
      if (node.type === "note") {
        setNoteTarget(undefined);
        const id = noteIdOf(node.id);
        const note = notes.find((n) => n.id === id);
        const session = sessionUnder(node);
        if (note && session !== undefined) {
          // Handing off copies the note: it goes back where it was.
          setNodes((ns) =>
            ns.map((n) => (n.id === node.id ? { ...n, position: { x: note.x, y: note.y } } : n)),
          );
          onHandoff({ kind: "note", sessionId: session, noteId: id }, session);
        } else {
          onNoteMove?.(id, { x: Math.round(node.position.x), y: Math.round(node.position.y) });
        }
      }
      const moved: CanvasPositions = {};
      for (const id of cardsMoved(nodes, dragged)) {
        const p = flow.getInternalNode(id)?.internals.positionAbsolute;
        if (p) moved[id] = { x: Math.round(p.x), y: Math.round(p.y) };
      }
      if (Object.keys(moved).length > 0) onMove(moved);
    },
    [nodes, flow, onMove, notes, sessionUnder, onHandoff, onNoteMove],
  );
  const dropPoint = (e: { clientX: number; clientY: number }): CanvasPoint => {
    const p = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    return { x: Math.round(p.x - NOTE_SIZE / 2), y: Math.round(p.y - NOTE_SIZE / 2) };
  };
  const edges = useMemo(() => model.links.map(toEdge), [model.links]);

  return (
    <main
      className="canvas"
      aria-label="Session canvas"
      onDragOver={(e) => {
        const types = Array.from(e.dataTransfer.types);
        const notesOk = onNoteCreate !== undefined;
        if (
          types.includes(SESSION_DRAG_TYPE) ||
          (notesOk && (types.includes(NOTE_PAD_DRAG_TYPE) || types.includes("Files")))
        ) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(SESSION_DRAG_TYPE);
        if (id) {
          e.preventDefault();
          onDropSession(id, flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
          return;
        }
        if (!onNoteCreate) return;
        if (e.dataTransfer.getData(NOTE_PAD_DRAG_TYPE)) {
          e.preventDefault();
          onNoteCreate(dropPoint(e));
        } else if (e.dataTransfer.files.length > 0) {
          // Files dropped on bare canvas: a new note holding them.
          e.preventDefault();
          onNoteCreate(dropPoint(e), Array.from(e.dataTransfer.files));
        }
      }}
    >
      <ReactFlow<CanvasNode, LinkEdgeType>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onNodeClick={(_, node) => {
          if (node.type === "session") onOpen(node.data.card.session.sessionId);
        }}
        nodesConnectable={false}
        edgesFocusable={false}
        deleteKeyCode={null}
        minZoom={0.2}
        maxZoom={2}
        defaultViewport={{ x: 0, y: 0, zoom: 1 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Lines} gap={32} color="rgba(255, 138, 43, 0.14)" />
        <Controls showInteractive={false} />
      </ReactFlow>
      {onNoteCreate && (
        <NotePad
          onClick={(box) => {
            const p = dropPoint({
              clientX: box.left + box.width / 2,
              clientY: box.top + box.height / 2,
            });
            // Fan new notes out a little so repeated clicks don't stack exactly.
            const jitter = (notes.length % 6) * 18;
            onNoteCreate({ x: p.x + jitter, y: p.y + jitter });
          }}
        />
      )}
      {model.groups.length === 0 && notes.length === 0 && (
        <p className="canvas-empty">Drag sessions from the sidebar onto the canvas.</p>
      )}
    </main>
  );
}

type Handlers = Pick<Props, "now" | "openId" | "onOpen" | "onRemove" | "onDomain" | "onHandoff">;

/**
 * React Flow nodes: each group's box, then its cards (children must follow
 * their parent), placed relative to the box so dragging the box moves them.
 */
export function toNodes(model: CanvasModel, h: Handlers, noteTarget?: string): CanvasNode[] {
  const nodes: CanvasNode[] = [];
  for (const g of model.groups) {
    nodes.push({
      id: g.key,
      type: "repo",
      position: g.position,
      data: { title: g.title, subtitle: g.subtitle, count: g.cards.length },
      style: { width: g.width, height: g.height },
      dragHandle: ".repo-head",
      selectable: false,
      zIndex: 0,
    });
    for (const c of g.cards) {
      nodes.push({
        id: c.key,
        type: "session",
        parentId: g.key,
        expandParent: true,
        position: { x: c.position.x - g.position.x, y: c.position.y - g.position.y },
        data: {
          card: c,
          now: h.now,
          open: c.session.sessionId === h.openId,
          onOpen: h.onOpen,
          onRemove: h.onRemove,
          onDomain: h.onDomain,
          onHandoff: h.onHandoff,
        },
        ...(c.session.sessionId === noteTarget ? { className: "is-note-target" } : {}),
        zIndex: 1,
      });
    }
  }
  return nodes;
}

const NO_NOTES: readonly Note[] = [];
const NOTE_PREFIX = "note:";

function noteIdOf(nodeId: string): string {
  return nodeId.startsWith(NOTE_PREFIX) ? nodeId.slice(NOTE_PREFIX.length) : nodeId;
}

/** Sticky notes as React Flow nodes, above the cards, at their canvas positions. */
export function toNoteNodes(
  notes: readonly Note[],
  h: Pick<NoteNodeType["data"], "onText" | "onFiles" | "onPreview">,
  armed?: string,
): NoteNodeType[] {
  return notes.map((note) => ({
    id: `${NOTE_PREFIX}${note.id}`,
    type: "note",
    position: { x: note.x, y: note.y },
    data: { note, armed: note.id === armed, ...h },
    style: { width: NOTE_SIZE, height: NOTE_SIZE },
    zIndex: 10,
  }));
}

export function toEdge(link: CanvasLink): LinkEdgeType {
  const color = LINK_COLORS[link.level];
  return {
    id: link.key,
    type: "link",
    source: link.source,
    target: link.target,
    className: `link is-${link.level}${link.directed ? " is-directed" : ""}`,
    style: { stroke: color, strokeWidth: link.level === "none" ? 2 : 3 },
    zIndex: 1,
    data: {
      label: link.label,
      level: link.level,
      directed: link.directed,
      shared: link.shared,
      color,
    },
  };
}

/**
 * Cards whose canvas position a drag changed: the dragged cards, and every
 * card in a dragged group.
 */
export function cardsMoved(nodes: readonly Node[], dragged: readonly Node[]): string[] {
  const ids = new Set<string>();
  const groups = new Set<string>();
  for (const d of dragged) {
    if (d.type === "note") continue;
    if (d.type === "repo") groups.add(d.id);
    else ids.add(d.id);
  }
  for (const n of nodes) if (n.parentId !== undefined && groups.has(n.parentId)) ids.add(n.id);
  return [...ids];
}

/**
 * `built` with React Flow's own state carried over from `current`: measured
 * sizes (without them it hides a node until it measures it again, so every
 * clock tick made the cards flicker and miss clicks), selection, and the
 * position of a node being dragged.
 */
export function mergeNodes<N extends Node>(current: readonly N[], built: readonly N[]): N[] {
  const byId = new Map(current.map((n) => [n.id, n]));
  return built.map((n) => {
    const c = byId.get(n.id);
    if (!c) return n;
    return {
      ...n,
      ...(c.measured === undefined ? {} : { measured: c.measured }),
      ...(c.selected === undefined ? {} : { selected: c.selected }),
      ...(c.dragging ? { position: c.position, dragging: true } : {}),
    };
  });
}
