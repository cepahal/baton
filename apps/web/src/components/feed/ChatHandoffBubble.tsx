import { setHandoffDrag } from "../../lib/drag.js";

type Props = { sessionId: string; events: number };

/**
 * The bubble at the foot of a session's feed. Dragged like a card's grip: drop
 * it on another session on the canvas to hand off the whole chat.
 */
export function ChatHandoffBubble({ sessionId, events }: Props) {
  return (
    <div
      className="chat-bubble"
      draggable
      role="note"
      title="Drag onto another session on the canvas to hand off this whole chat"
      onDragStart={(e) => setHandoffDrag(e.dataTransfer, { kind: "chat", sessionId })}
    >
      <span className="chat-bubble-grip" aria-hidden>
        ⠿
      </span>
      <span className="chat-bubble-text">
        <b>Whole chat</b>
        <span>{events} events · drag onto a session to hand off</span>
      </span>
    </div>
  );
}
