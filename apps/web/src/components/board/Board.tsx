import { type DragEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { CARD_DRAG_TYPE, isOutside, parseCardDrag, SESSION_DRAG_TYPE } from "../../lib/drag.js";
import { CARD_H, CARD_W, GRID, type Point, type Positions, place } from "../../lib/positions.js";

type Props = {
  ids: readonly string[];
  positions: Positions;
  max: number;
  full: boolean;
  onDropSession(sessionId: string, at: Point): void;
  onMoveCard(sessionId: string, at: Point): void;
  onRemoveCard(sessionId: string): void;
  onWidth(width: number): void;
  renderCard(sessionId: string): ReactNode;
};

/**
 * The gridline board. Sessions dropped from the sidebar land where they are
 * dropped; cards can be dragged around, and a card
 * dragged off the board is removed.
 */
export function Board(props: Props) {
  const { ids, positions, onWidth } = props;
  const [over, setOver] = useState(false);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => onWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [onWidth]);

  const boardPoint = (e: DragEvent): Point => {
    const el = ref.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left + el.scrollLeft, y: e.clientY - r.top + el.scrollTop };
  };

  const accepts = (e: DragEvent) =>
    e.dataTransfer.types.includes(CARD_DRAG_TYPE) ||
    (e.dataTransfer.types.includes(SESSION_DRAG_TYPE) && !props.full);

  let width = 0;
  let height = 0;
  for (const id of ids) {
    const p = positions[id];
    if (!p) continue;
    width = Math.max(width, p.x + CARD_W + GRID);
    height = Math.max(height, p.y + CARD_H + GRID);
  }

  return (
    <main
      ref={ref}
      className={`board${over ? " is-over" : ""}`}
      onDragOver={(e) => {
        if (!accepts(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = e.dataTransfer.types.includes(CARD_DRAG_TYPE) ? "move" : "copy";
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setOver(false);
      }}
      onDrop={(e) => {
        setOver(false);
        const at = boardPoint(e);
        const card = parseCardDrag(e.dataTransfer.getData(CARD_DRAG_TYPE));
        if (card) {
          e.preventDefault();
          props.onMoveCard(card.id, place({ x: at.x - card.dx, y: at.y - card.dy }));
          return;
        }
        const id = e.dataTransfer.getData(SESSION_DRAG_TYPE);
        if (!id) return;
        e.preventDefault();
        props.onDropSession(id, place({ x: at.x - CARD_W / 2, y: at.y - GRID }));
      }}
    >
      {ids.length === 0 ? (
        <div className="placeholder">
          <span className="brand-orb big" aria-hidden />
          <p>
            Drag up to {props.max} sessions from the left anywhere onto the board to watch them
            live. Drag a card off the board to remove it.
          </p>
        </div>
      ) : (
        <div className="board-canvas" style={{ width, height }}>
          {ids.map((id) => {
            const p = positions[id];
            if (!p) return null;
            return (
              // biome-ignore lint/a11y/noStaticElementInteractions: a drag handle for the card; the card's own button is the interactive part.
              <div
                key={id}
                className="card-slot"
                style={{ left: p.x, top: p.y, width: CARD_W, height: CARD_H }}
                draggable
                onDragStart={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  e.dataTransfer.setData(
                    CARD_DRAG_TYPE,
                    JSON.stringify({ id, dx: e.clientX - r.left, dy: e.clientY - r.top }),
                  );
                  e.dataTransfer.effectAllowed = "move";
                  e.currentTarget.classList.add("is-dragging");
                }}
                onDragEnd={(e) => {
                  e.currentTarget.classList.remove("is-dragging");
                  const board = ref.current?.getBoundingClientRect();
                  if (
                    e.dataTransfer.dropEffect === "none" &&
                    board &&
                    isOutside({ x: e.clientX, y: e.clientY }, board)
                  ) {
                    props.onRemoveCard(id);
                  }
                }}
              >
                {props.renderCard(id)}
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}
