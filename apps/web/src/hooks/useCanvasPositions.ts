import type { CanvasMessage, CanvasPositions } from "@baton/core";
import { useCallback, useEffect, useState } from "react";
import { fetchCanvas, saveCanvas } from "../lib/canvas-api.js";

export type CanvasPositionsState = {
  /** Every card on the canvas, by `session:<id>`, at its canvas position. */
  positions: CanvasPositions;
  /** Apply a `canvas` socket message (another viewer, or our own echo). */
  onMessage(message: CanvasMessage): void;
  /** Store nodes this viewer moved or placed: shown at once, then saved for the team. */
  move(moved: CanvasPositions): void;
  /** Take nodes off the canvas for everyone. */
  remove(keys: readonly string[]): void;
  error: string | undefined;
};

/** The team's shared canvas: loaded once, kept live by the socket. */
export function useCanvasPositions(): CanvasPositionsState {
  const [positions, setPositions] = useState<CanvasPositions>({});
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    fetchCanvas(controller.signal).then(
      // Socket updates may already have landed; they're newer than this snapshot.
      (loaded) => setPositions((p) => ({ ...loaded, ...p })),
      (err: unknown) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => controller.abort();
  }, []);

  const onMessage = useCallback((message: CanvasMessage) => {
    setPositions((p) => applyCanvasMessage(p, message));
  }, []);

  const report = useCallback((saving: Promise<void>) => {
    saving.then(
      () => setError(undefined),
      (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    );
  }, []);

  const move = useCallback(
    (moved: CanvasPositions) => {
      setPositions((p) => ({ ...p, ...moved }));
      report(saveCanvas(moved));
    },
    [report],
  );

  const remove = useCallback(
    (keys: readonly string[]) => {
      setPositions((p) =>
        applyCanvasMessage(p, { type: "canvas", positions: {}, removed: [...keys] }),
      );
      report(saveCanvas({}, keys));
    },
    [report],
  );

  return { positions, onMessage, move, remove, error };
}

/** `positions` after a `canvas` message: moved nodes updated, removed ones gone. */
export function applyCanvasMessage(
  positions: CanvasPositions,
  message: CanvasMessage,
): CanvasPositions {
  if (message.snapshot) return { ...message.positions };
  const next = { ...positions, ...message.positions };
  for (const key of message.removed ?? []) delete next[key];
  return next;
}
