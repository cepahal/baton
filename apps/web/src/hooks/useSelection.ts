import { useState, useSyncExternalStore } from "react";
import { Selection, type SelectionStorage } from "../lib/selection.js";

function browserStorage(): SelectionStorage | undefined {
  try {
    return window.localStorage;
  } catch {
    // Accessing localStorage can throw when storage is blocked.
    return undefined;
  }
}

/** Which sessions have a column open, remembered across reloads. */
export function useSelection(max: number) {
  const [selection] = useState(() => new Selection(browserStorage(), max));
  const selected = useSyncExternalStore(selection.subscribe, selection.get);
  return {
    selected,
    toggle: selection.toggle,
    remove: selection.remove,
    initialize: selection.initialize,
  };
}
