import type { DomainLabel } from "@baton/core";
import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import { useState } from "react";
import type { CanvasCard } from "../../lib/canvas-model.js";
import {
  type HandoffDrag,
  isHandoffDrag,
  readHandoffDrag,
  setHandoffDrag,
} from "../../lib/drag.js";
import { formatAgo, isLive } from "../../lib/time.js";
import { AgentIcon, agentLabel } from "../AgentIcon.js";
import { LiveDot } from "../LiveDot.js";
import { ContractCaution } from "./ContractCaution.js";
import { DomainChip } from "./DomainChip.js";

export type SessionNodeData = {
  card: CanvasCard;
  now: number;
  open: boolean;
  onOpen(sessionId: string): void;
  onRemove(sessionId: string): void;
  onDomain(sessionId: string, label: DomainLabel | null): void;
  onHandoff(drag: HandoffDrag, toSessionId: string): void;
};
export type SessionNodeType = Node<SessionNodeData, "session">;

/**
 * A session card on the canvas. Click to open its feed; drag to move; drag
 * its grip onto another card to hand the session off; drop a feed event on it
 * to send a snippet.
 */
export function SessionNode({ data }: NodeProps<SessionNodeType>) {
  const { card, now, open } = data;
  const s = card.session;
  const live = isLive(s.lastActivity, now);
  const user = s.user ?? s.source ?? "local";
  const [target, setTarget] = useState(false);
  return (
    <article
      className={`scard${open ? " is-open" : ""}${target ? " is-drop-target" : ""}`}
      aria-label={`Session ${s.projectName}`}
      title={s.projectPath}
      onDragOver={(e) => {
        if (!isHandoffDrag(e.dataTransfer)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
        setTarget(true);
      }}
      onDragLeave={() => setTarget(false)}
      onDrop={(e) => {
        setTarget(false);
        const drag = readHandoffDrag(e.dataTransfer);
        if (!drag) return;
        e.preventDefault();
        e.stopPropagation();
        if (drag.sessionId !== s.sessionId) data.onHandoff(drag, s.sessionId);
      }}
    >
      <Handle type="target" position={Position.Left} className="scard-handle" />
      <Handle type="source" position={Position.Right} className="scard-handle" />
      <header className="scard-head">
        <button
          type="button"
          className="scard-grip nodrag"
          draggable
          tabIndex={-1}
          aria-label="Drag onto another card to hand this session off"
          title="Drag onto another card to hand this session off"
          onDragStart={(e) => {
            e.stopPropagation();
            setHandoffDrag(e.dataTransfer, { kind: "full", sessionId: s.sessionId });
          }}
        >
          ⠿
        </button>
        <LiveDot live={live} />
        <span className="scard-user">{user}</span>
        <span className="agent-badge" title={agentLabel(s.agent)}>
          <AgentIcon agent={s.agent} />
          {agentLabel(s.agent)}
        </span>
        <button
          type="button"
          className="scard-remove nodrag"
          aria-label="Remove from canvas"
          title="Remove from canvas"
          onClick={(e) => {
            e.stopPropagation();
            data.onRemove(s.sessionId);
          }}
        >
          ×
        </button>
      </header>
      <DomainChip domain={card.domain} onPick={(label) => data.onDomain(s.sessionId, label)} />
      <div className="scard-branch" title="Branch">
        <span aria-hidden>⎇</span> {s.repo?.branch ?? <span className="is-faint">no branch</span>}
        {s.repo?.relativeCwd ? <span className="scard-cwd"> · {s.repo.relativeCwd}</span> : null}
      </div>
      <ContractCaution issues={s.contractIssues} />
      <footer className="scard-foot">
        {live ? "active " : "last active "}
        {formatAgo(Date.parse(s.lastActivity), now)}
        {s.files && s.files.length > 0
          ? ` · ${s.files.length} file${s.files.length === 1 ? "" : "s"}`
          : ""}
      </footer>
    </article>
  );
}
