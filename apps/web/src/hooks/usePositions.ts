import { useCallback, useState } from "react";
import { loadPositions, type Point, type Positions, savePositions } from "../lib/positions.js";

function browserStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** Where each card sits on the board, remembered across reloads. */
export function usePositions() {
  const [positions, setPositions] = useState<Positions>(() => loadPositions(browserStorage()));
  const move = useCallback((id: string, p: Point) => {
    setPositions((prev) => {
      const next = { ...prev, [id]: p };
      savePositions(browserStorage(), next);
      return next;
    });
  }, []);
  const forget = useCallback((id: string) => {
    setPositions((prev) => {
      const next = { ...prev };
      delete next[id];
      savePositions(browserStorage(), next);
      return next;
    });
  }, []);
  return { positions, move, forget };
}
