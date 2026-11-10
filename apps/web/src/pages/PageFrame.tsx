import { type ReactNode, useState } from "react";

/** The plain layout of Baton's standalone pages (handoff, pairing). */
export function PageFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="page">
      <header className="page-head">
        <a href="/" className="page-home">
          ← Baton
        </a>
        <h1>{title}</h1>
      </header>
      <main className="page-body">{children}</main>
    </div>
  );
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => undefined,
        );
      }}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

/** What an unpaired browser sees where it would answer a handoff. */
export function PairPrompt() {
  return (
    <div className="page-pair">
      <p>
        <b>Pair this browser</b> to accept or decline handoffs sent to your machine. On that
        machine, run:
      </p>
      <pre>baton pair --server &lt;this server&gt;</pre>
      <p className="page-faint">
        and open the link it prints here. <code>baton start --server</code> prints one when it
        starts, too. A link works once, for 10 minutes.
      </p>
    </div>
  );
}
