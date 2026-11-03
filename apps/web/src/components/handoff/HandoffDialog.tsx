import type { Handoff, HandoffDraft, SessionInfo } from "@baton/core";
import { useEffect, useRef, useState } from "react";
import type { HandoffDrag } from "../../lib/drag.js";
import { draftHandoff, loadSender, saveSender, sendHandoff } from "../../lib/handoff-api.js";
import { agentLabel } from "../AgentIcon.js";

type Props = {
  drag: HandoffDrag;
  from: SessionInfo | undefined;
  to: SessionInfo | undefined;
  onSent(handoff: Handoff): void;
  onClose(): void;
};

const storage = (): Storage | undefined =>
  typeof localStorage === "undefined" ? undefined : localStorage;

export function partyLabel(s: SessionInfo | undefined): string {
  if (!s) return "unknown session";
  return `${s.user ?? s.source ?? "local"}'s ${agentLabel(s.agent)} (${s.projectName})`;
}

/**
 * The sender's preview: the drafted packet, editable. Text only: no code is
 * sent. Nothing is sent until "Send handoff".
 */
const DIALOG_TITLES = {
  full: "Hand off session",
  chat: "Hand off the whole chat",
  snippet: "Send snippet",
  note: "Send sticky note",
} as const;

export function HandoffDialog({ drag, from, to, onSent, onClose }: Props) {
  const [draft, setDraft] = useState<HandoffDraft | undefined>(undefined);
  const [markdown, setMarkdown] = useState("");
  const [sender, setSender] = useState(() => loadSender(storage()));
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const toId = to?.sessionId;
  // The sender name only labels the draft's header: read it, don't redraft as it is typed.
  const senderRef = useRef(sender);
  senderRef.current = sender;

  useEffect(() => {
    if (toId === undefined) return;
    const abort = new AbortController();
    draftHandoff(
      {
        kind: drag.kind,
        fromSessionId: drag.sessionId,
        toSessionId: toId,
        ...(drag.kind === "snippet" ? { eventId: drag.eventId } : {}),
        ...(drag.kind === "note" ? { noteId: drag.noteId } : {}),
        ...(senderRef.current.trim() ? { sender: senderRef.current.trim() } : {}),
      },
      abort.signal,
    ).then(
      (d) => {
        setDraft(d);
        setMarkdown(d.markdown);
      },
      (err: unknown) => {
        // Drafting failed: still let the sender write the handoff by hand.
        if (!abort.signal.aborted) {
          setError(
            `Couldn't draft this handoff (${err instanceof Error ? err.message : String(err)}). Write it below and send.`,
          );
        }
      },
    );
    return () => abort.abort();
  }, [drag, toId]);

  const send = () => {
    if (!toId || !sender.trim()) return;
    setBusy(true);
    setError(undefined);
    saveSender(storage(), sender.trim());
    sendHandoff({
      kind: drag.kind,
      fromSessionId: drag.sessionId,
      toSessionId: toId,
      ...(drag.kind === "snippet" ? { eventId: drag.eventId } : {}),
      ...(drag.kind === "note" ? { noteId: drag.noteId } : {}),
      markdown,
      sender: sender.trim(),
    }).then(onSent, (err: unknown) => {
      setBusy(false);
      setError(err instanceof Error ? err.message : String(err));
    });
  };

  return (
    <div className="handoff-backdrop">
      <div
        className="handoff-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Hand off"
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
        <header className="handoff-head">
          <h2>{DIALOG_TITLES[drag.kind]}</h2>
          <button type="button" className="handoff-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        <p className="handoff-route">
          {drag.kind === "note" ? "Sticky note" : partyLabel(from)} <span aria-hidden>→</span>{" "}
          {partyLabel(to)}
        </p>
        {draft?.warning && <p className="handoff-warning">{draft.warning}</p>}
        {draft && (
          <p className="handoff-meta">
            {draft.summarizer === "model"
              ? "Summarized by the model. Check it before sending."
              : draft.summarizer === "heuristic"
                ? draft.warning
                  ? "Edit freely before sending."
                  : "Drafted from the transcript (no summarizer configured). Edit freely."
                : drag.kind === "note"
                  ? "A copy of the note, and of any files on it. The note stays on the canvas."
                  : drag.kind === "chat"
                    ? "The whole conversation, built from the transcript (no model). Edit freely."
                    : "The event, as it appears in the feed."}
          </p>
        )}
        {draft || error ? (
          <textarea
            className="handoff-text"
            value={markdown}
            onChange={(e) => setMarkdown(e.target.value)}
            spellCheck={false}
            aria-label="Handoff text"
          />
        ) : (
          !error && <p className="handoff-loading">Drafting…</p>
        )}
        <div className="handoff-options">
          <label>
            Your name{" "}
            <input
              value={sender}
              maxLength={64}
              onChange={(e) => setSender(e.target.value)}
              placeholder="shown to the receiver"
            />
          </label>
        </div>
        {error && (
          <p className="handoff-error" role="alert">
            {error}
          </p>
        )}
        <footer className="handoff-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || (!draft && !error) || !sender.trim() || markdown.trim() === ""}
            onClick={send}
          >
            {busy ? "Sending…" : "Send handoff"}
          </button>
        </footer>
      </div>
    </div>
  );
}
