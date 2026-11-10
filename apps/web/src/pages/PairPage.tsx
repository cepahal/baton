import type { MeResponse } from "@baton/core";
import { useEffect, useState } from "react";
import { claimPairing } from "../lib/handoff-api.js";
import { PageFrame, PairPrompt } from "./PageFrame.js";

type State =
  | { kind: "claiming" }
  | { kind: "paired"; me: MeResponse }
  | { kind: "failed"; error: string }
  | { kind: "no-code" };

/** Reads the one-time code from the fragment once, and wipes it from the address bar. */
function takeCode(): string | undefined {
  const code = window.location.hash.replace(/^#/, "");
  if (code !== "") window.history.replaceState(null, "", window.location.pathname);
  return code === "" ? undefined : code;
}

/**
 * `/pair#<code>`: binds this browser to the machine that printed the link,
 * so it can answer handoffs sent there. The code travels in the fragment,
 * which never reaches the server's logs; it is posted once and works once.
 */
export function PairPage({ onPaired }: { onPaired(): void }) {
  const [code] = useState(takeCode);
  const [state, setState] = useState<State>(code ? { kind: "claiming" } : { kind: "no-code" });

  useEffect(() => {
    if (!code) return;
    claimPairing(code).then(
      (me) => {
        setState({ kind: "paired", me });
        onPaired();
      },
      (err: unknown) =>
        setState({ kind: "failed", error: err instanceof Error ? err.message : String(err) }),
    );
  }, [code, onPaired]);

  return (
    <PageFrame title="Pair this browser">
      <section className="page-card">
        {state.kind === "claiming" && <p className="page-faint">Pairing…</p>}
        {state.kind === "paired" && (
          <>
            <h2>Paired with {state.me.pairing?.name ?? "your machine"}</h2>
            <p>
              Handoffs sent to {state.me.pairing?.name ?? "it"} show up under "for you" in the
              Handoffs tray, and you can accept or decline them from this browser.
            </p>
            <p>
              <a href="/">Back to Baton</a>
            </p>
          </>
        )}
        {state.kind === "failed" && (
          <>
            <p className="page-error" role="alert">
              {state.error}
            </p>
            <PairPrompt />
          </>
        )}
        {state.kind === "no-code" && <PairPrompt />}
      </section>
    </PageFrame>
  );
}
