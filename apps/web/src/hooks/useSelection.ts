import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";

const KEY = "baton.selectedSessions";
const Stored = z.array(z.string()).catch([]);

function load(): string[] | undefined {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === null ? undefined : Stored.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/** Which sessions have a column open, remembered across reloads. */
export function useSelection(max: number) {
  const stored = useRef(load());
  const [selected, setSelected] = useState<string[]>(() => (stored.current ?? []).slice(0, max));

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(selected));
    } catch {
      // Storage may be unavailable (private mode); selection just won't persist.
    }
  }, [selected]);

  const toggle = useCallback(
    (id: string) =>
      setSelected((s) =>
        s.includes(id) ? s.filter((x) => x !== id) : s.length < max ? [...s, id] : s,
      ),
    [max],
  );
  const remove = useCallback((id: string) => setSelected((s) => s.filter((x) => x !== id)), []);

  /** Sets a default selection once, only if nothing was remembered. */
  const initialized = useRef(stored.current !== undefined);
  const initialize = useCallback((ids: string[]) => {
    if (initialized.current) return;
    initialized.current = true;
    setSelected(ids);
  }, []);

  return { selected, toggle, remove, initialize };
}
