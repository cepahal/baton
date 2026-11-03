/** The drag payload type for a fresh note pulled off the pad. */
export const NOTE_PAD_DRAG_TYPE = "application/x-baton-note-pad";

type Props = {
  /** Clicked rather than dragged: stick a note in the middle of the view. */
  onClick(canvasBox: DOMRect): void;
};

/**
 * The pad of sticky notes in the canvas's top-left corner. Drag a note off it
 * onto the canvas (it comes out yellow, pink, orange or baby blue), or click it.
 * No label: it's a picture of a sticky note, named for screen readers only.
 */
export function NotePad({ onClick }: Props) {
  return (
    <button
      type="button"
      className="note-pad"
      aria-label="Add a sticky note"
      title="Drag onto the canvas to add a sticky note"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(NOTE_PAD_DRAG_TYPE, "1");
        e.dataTransfer.setData("text/plain", "Baton sticky note");
        e.dataTransfer.effectAllowed = "copy";
      }}
      onClick={(e) => {
        const box = (e.currentTarget.closest(".canvas") ?? e.currentTarget).getBoundingClientRect();
        onClick(box);
      }}
    >
      <span className="note-pad-sheet note-pad-under" aria-hidden />
      <span className="note-pad-sheet" aria-hidden>
        <span className="note-pad-curl" />
      </span>
    </button>
  );
}
