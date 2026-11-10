import type { MeResponse } from "@baton/core";
import { useCallback, useEffect, useState } from "react";
import { fetchMe } from "../lib/handoff-api.js";

/** `GET /me`, re-read on demand (after pairing). Undefined until loaded or if it failed. */
export function useMe(): { me: MeResponse | undefined; refresh(): void } {
  const [me, setMe] = useState<MeResponse | undefined>(undefined);
  const refresh = useCallback(() => {
    fetchMe().then(setMe, () => undefined);
  }, []);
  useEffect(refresh, [refresh]);
  return { me, refresh };
}
