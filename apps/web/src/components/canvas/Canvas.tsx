import type { CanvasPoint, CanvasPositions, DomainLabel } from "@baton/core";
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
};

type CanvasNode = RepoNodeType | SessionNodeType;

const nodeTypes = { repo: RepoNode, session: SessionNode };
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
  const built = useMemo(
    () => toNodes(model, { now, openId, onOpen, onRemove, onDomain, onHandoff }),
    [model, now, openId, onOpen, onRemove, onDomain, onHandoff],
  );
  const [nodes, setNodes] = useState<CanvasNode[]>(built);
  // New data replaces the nodes, keeping what React Flow learnt about them.
  useEffect(() => setNodes((current) => mergeNodes(current, built)), [built]);

  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => setNodes((ns) => applyNodeChanges(changes, ns)),
    [],
  );
  const onNodeDragStop = useCallback(
    (_: unknown, _node: Node, dragged: Node[]) => {
      const moved: CanvasPositions = {};
      for (const id of cardsMoved(nodes, dragged)) {
        const p = flow.getInternalNode(id)?.internals.positionAbsolute;
        if (p) moved[id] = { x: Math.round(p.x), y: Math.round(p.y) };
      }
      if (Object.keys(moved).length > 0) onMove(moved);
    },
    [nodes, flow, onMove],
  );
  const edges = useMemo(() => model.links.map(toEdge), [model.links]);

  return (
    <main
      className="canvas"
      aria-label="Session canvas"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(SESSION_DRAG_TYPE)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(SESSION_DRAG_TYPE);
        if (id) {
          e.preventDefault();
          onDropSession(id, flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
        }
      }}
    >
      <ReactFlow<CanvasNode, LinkEdgeType>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
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
      {model.groups.length === 0 && (
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
export function toNodes(model: CanvasModel, h: Handlers): CanvasNode[] {
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
        zIndex: 1,
      });
    }
  }
  return nodes;
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
