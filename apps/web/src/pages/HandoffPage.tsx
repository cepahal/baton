import {
  type Handoff,
  type HandoffParty,
  type HandoffView,
  handoffCommand,
  handoffPrompt,
  type MeResponse,
  shellFolder,
} from "@baton/core";
import { useCallback, useEffect, useState } from "react";
import { agentLabel } from "../components/AgentIcon.js";
import { HANDOFF_KIND_NAMES } from "../lib/drag.js";
import { acceptHandoff, declineHandoff, fetchHandoffView } from "../lib/handoff-api.js";
import { CopyButton, PageFrame, PairPrompt } from "./PageFrame.js";

type Props = { id: string; me: MeResponse | undefined };

/**
 * `/handoffs/:id`: a handoff's preview and, for a browser paired with the
 * receiving machine, Accept / Decline. Accepting asks that machine to write
 * the handoff's files into a folder; it starts nothing there. The page then
 * shows the prompt and the commands to run yourself.
 */
export function HandoffPage({ id, me }: Props) {
  const [view, setView] = useState<HandoffView | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const load = useCallback(
    (signal?: AbortSignal) =>
      fetchHandoffView(id, signal).then(
        (v) => {
          setView(v);
          setError(undefined);
        },
        (err: unknown) => {
          if (!signal?.aborted) setError(err instanceof Error ? err.message : String(err));
        },
      ),
    [id],
  );
  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal);
    // Someone may answer it elsewhere (another tab, the CLI): re-read on focus.
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      abort.abort();
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  if (error && !view) {
    return (
      <PageFrame title="Handoff">
        <p className="page-error" role="alert">
          {error}
        </p>
      </PageFrame>
    );
  }
  if (!view) {
    return (
      <PageFrame title="Handoff">
        <p className="page-faint">Loading…</p>
      </PageFrame>
    );
  }
  const { handoff } = view;
  return (
    <PageFrame title={`${capital(HANDOFF_KIND_NAMES[handoff.kind])} from ${handoff.sender}`}>
      <p className="page-route">
        {party(handoff.from, handoff.kind === "note")} <span aria-hidden>→</span>{" "}
        {party(handoff.to, false)}
        <span className={`handoff-status is-${handoff.status}`}>{handoff.status}</span>
      </p>
      <Preview handoff={handoff} />
      {handoff.status === "pending" &&
        (view.canAnswer ? (
          <Answer handoff={handoff} onDone={setView} />
        ) : (
          <NotYours why={view.why} me={me} />
        ))}
      {handoff.status === "accepted" && <Accepted handoff={handoff} />}
      {handoff.status === "declined" && (
        <section className="page-card">
          <h2>Declined</h2>
          {handoff.note ? <blockquote>{handoff.note}</blockquote> : <p>No note.</p>}
        </section>
      )}
    </PageFrame>
  );
}

function Preview({ handoff }: { handoff: Handoff }) {
  const code = handoff.code;
  return (
    <>
      <section className="page-card">
        <h2>What was sent</h2>
        <pre className="handoff-preview">{handoff.markdown}</pre>
        {handoff.attachments && handoff.attachments.length > 0 && (
          <p className="page-faint">Files: {handoff.attachments.map((f) => f.name).join(", ")}</p>
        )}
      </section>
      {code && (
        <section className="page-card">
          <h2>Code changes</h2>
          {code.state === "attached" ? (
            <>
              <p>
                {code.files?.length ?? 0} changed file{code.files?.length === 1 ? "" : "s"} (
                {formatBytes(code.bytes ?? 0)}) on {code.branch ?? "a detached HEAD"}, against{" "}
                <code>{code.base?.slice(0, 12)}</code>. Saved as <code>changes.patch</code> with the
                handoff.
              </p>
              {code.files && code.files.length > 0 && (
                <ul className="page-files">
                  {code.files.slice(0, 50).map((f) => (
                    <li key={f}>
                      <code>{f}</code>
                    </li>
                  ))}
                </ul>
              )}
              {code.skipped && code.skipped.length > 0 && (
                <p className="page-faint">
                  Left out: {code.skipped.map((s) => `${s.path} (${s.reason})`).join(", ")}
                </p>
              )}
              {code.redacted && code.redacted.length > 0 && (
                <p className="page-faint">Secrets masked in: {code.redacted.join(", ")}</p>
              )}
            </>
          ) : (
            <p className="page-faint">No code attached: {code.reason ?? "unavailable"}.</p>
          )}
        </section>
      )}
    </>
  );
}

function Answer({ handoff, onDone }: { handoff: Handoff; onDone(view: HandoffView): void }) {
  const [folder, setFolder] = useState("");
  const [needFolder, setNeedFolder] = useState(false);
  const [note, setNote] = useState("");
  const [declining, setDeclining] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const accept = () => {
    setBusy(true);
    setError(undefined);
    acceptHandoff(handoff.id, folder.trim() || undefined).then((result) => {
      setBusy(false);
      if (result.ok) {
        onDone({ handoff: result.handoff, canAnswer: true });
        return;
      }
      setError(result.error);
      if (result.needFolder) setNeedFolder(true);
    });
  };
  const decline = () => {
    setBusy(true);
    setError(undefined);
    declineHandoff(handoff.id, note.trim() || undefined).then(
      (h) => onDone({ handoff: h, canAnswer: true }),
      (err: unknown) => {
        setBusy(false);
        setError(err instanceof Error ? err.message : String(err));
      },
    );
  };

  return (
    <section className="page-card is-answer">
      <h2>Answer</h2>
      <p>
        Accepting asks your machine to save this handoff
        {handoff.code?.state === "attached" ? " and its changes.patch" : ""} as files in a folder.
        Nothing runs: you start your agent yourself.
      </p>
      <label className="page-field">
        Folder on your machine{needFolder ? "" : " (optional)"}
        <input
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
          placeholder={
            needFolder
              ? "an absolute path, e.g. /home/you/project"
              : "default: your session's folder"
          }
          aria-label="Destination folder"
          spellCheck={false}
          // biome-ignore lint/a11y/noAutofocus: the one thing left to do on the page
          autoFocus={needFolder}
        />
      </label>
      {declining && (
        <label className="page-field">
          Note for {handoff.sender} (optional)
          <textarea
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
            aria-label="Decline note"
          />
        </label>
      )}
      {error && (
        <p className="page-error" role="alert">
          {error}
        </p>
      )}
      <div className="page-actions">
        {declining ? (
          <>
            <button type="button" disabled={busy} onClick={() => setDeclining(false)}>
              Back
            </button>
            <button type="button" className="danger" disabled={busy} onClick={decline}>
              {busy ? "Declining…" : "Decline"}
            </button>
          </>
        ) : (
          <>
            <button type="button" disabled={busy} onClick={() => setDeclining(true)}>
              Decline…
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy || (needFolder && folder.trim() === "")}
              onClick={accept}
            >
              {busy ? "Saving…" : "Accept"}
            </button>
          </>
        )}
      </div>
    </section>
  );
}

function NotYours({ why, me }: { why: string | undefined; me: MeResponse | undefined }) {
  const unpaired = me !== undefined && !me.local && me.pairing === null;
  return (
    <section className="page-card">
      <h2>Waiting for the receiver</h2>
      {why && <p>{why}</p>}
      {unpaired && <PairPrompt />}
    </section>
  );
}

function Accepted({ handoff }: { handoff: Handoff }) {
  const delivery = handoff.delivery;
  if (!delivery) {
    return (
      <section className="page-card">
        <h2>Accepted</h2>
      </section>
    );
  }
  const withPatch = handoff.code?.state === "attached";
  const prompt = handoffPrompt(handoff.id, withPatch);
  const command = handoffCommand(handoff.to.agent, delivery.folder, prompt);
  const apply = `cd ${shellFolder(delivery.folder)} && baton handoff apply ${handoff.id}`;
  return (
    <section className="page-card is-answer">
      <h2>Saved on {handoff.to.daemon ?? "your machine"}</h2>
      <p>
        <code>{delivery.path}</code>
      </p>
      <h3>Prompt for {agentLabel(handoff.to.agent)}</h3>
      <div className="page-copy">
        <pre>{prompt}</pre>
        <CopyButton text={prompt} label="Copy prompt" />
      </div>
      <h3>Or start it from a terminal</h3>
      <div className="page-copy">
        <pre>{command}</pre>
        <CopyButton text={command} label="Copy command" />
      </div>
      {withPatch &&
        (delivery.apply.available ? (
          <>
            <h3>Apply the sender's changes on a new branch</h3>
            <div className="page-copy">
              <pre>{apply}</pre>
              <CopyButton text={apply} label="Copy command" />
            </div>
          </>
        ) : (
          <p className="page-faint">
            Applying the patch automatically isn't available: {delivery.apply.reason}
          </p>
        ))}
    </section>
  );
}

function party(p: HandoffParty, isNote: boolean): string {
  if (isNote) return "Sticky note";
  const who = p.user ?? p.daemon ?? "teammate";
  return `${who}'s ${agentLabel(p.agent)}`;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
