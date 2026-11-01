import type { BatonEvent } from "@baton/core";
import { memo, type ReactNode, useState } from "react";
import { metaBool, metaNumber, metaString } from "../../lib/meta.js";
import { formatClock } from "../../lib/time.js";
import { Markdown } from "./Markdown.js";

type Props = { event: BatonEvent };

/**
 * One event, self-contained: everything it shows comes from `event`, so it can
 * sit in a feed column today and inside a canvas card later.
 */
export const EventCard = memo(function EventCard({ event }: Props) {
  switch (event.kind) {
    case "prompt":
      return <PromptCard event={event} />;
    case "reply":
      return <ReplyCard event={event} />;
    case "thinking":
      return <ThinkingCard event={event} />;
    case "tool_call":
      return <ToolCallLine event={event} />;
    case "tool_result":
      return <ToolResultLine event={event} />;
    case "system":
      return <SystemLine event={event} />;
    case "session_start":
      return <SessionStartLine event={event} />;
  }
});

function Stamp({ event }: Props) {
  return (
    <time className="stamp" dateTime={event.ts} title={event.ts}>
      {formatClock(event.ts)}
    </time>
  );
}

export function PromptCard({ event }: Props) {
  const sources = event.meta?.sources;
  const extra = Array.isArray(sources)
    ? sources.filter((s): s is string => typeof s === "string" && s !== "typed")
    : [];
  return (
    <article className="ev ev-prompt">
      <header className="ev-head">
        <span className="ev-label">Prompt</span>
        {extra.length > 0 && <span className="ev-model">{extra.join(" + ")}</span>}
        <Stamp event={event} />
      </header>
      <p className="ev-plain">{event.text}</p>
    </article>
  );
}

export function ReplyCard({ event }: Props) {
  const model = metaString(event, "model");
  return (
    <article className="ev ev-reply">
      <header className="ev-head">
        <span className="ev-label">Reply</span>
        {model && <span className="ev-model">{model}</span>}
        <Stamp event={event} />
      </header>
      <Markdown text={event.text} />
    </article>
  );
}

export function ThinkingCard({ event }: Props) {
  const [open, setOpen] = useState(false);
  const empty = event.text.trim() === "";
  return (
    <article className="ev ev-thinking">
      <button
        type="button"
        className="ev-toggle"
        aria-expanded={open}
        disabled={empty}
        onClick={() => setOpen((o) => !o)}
      >
        <Caret open={open} />
        {empty ? "Thinking (hidden)" : open ? "Hide thinking" : "Show thinking"}
      </button>
      <Stamp event={event} />
      {open && !empty && <p className="ev-plain ev-thinking-body">{event.text}</p>}
    </article>
  );
}

export function ToolCallLine({ event }: Props) {
  const [open, setOpen] = useState(false);
  const input = event.meta?.input;
  return (
    <div className="ev ev-tool ev-tool-call">
      <ToolRow
        icon="›"
        open={open}
        onToggle={input === undefined ? undefined : () => setOpen((o) => !o)}
        event={event}
      >
        {event.text}
      </ToolRow>
      {open && <pre className="ev-full">{JSON.stringify(input, null, 2)}</pre>}
    </div>
  );
}

export function ToolResultLine({ event }: Props) {
  const [open, setOpen] = useState(false);
  const full = metaString(event, "full");
  const lines = metaNumber(event, "lines");
  const isError = metaBool(event, "isError");
  return (
    <div className={`ev ev-tool ev-tool-result${isError ? " is-error" : ""}`}>
      <ToolRow
        icon={isError ? "✕" : "‹"}
        open={open}
        onToggle={full ? () => setOpen((o) => !o) : undefined}
        event={event}
        hint={full && lines !== undefined ? `${lines} line${lines === 1 ? "" : "s"}` : undefined}
      >
        {event.text}
      </ToolRow>
      {open && full && <pre className="ev-full">{full}</pre>}
    </div>
  );
}

export function SystemLine({ event }: Props) {
  const [open, setOpen] = useState(false);
  const full = metaString(event, "full");
  const source = metaString(event, "source") ?? "system";
  const level = metaString(event, "level");
  return (
    <div className={`ev ev-system${level ? ` level-${level}` : ""}`}>
      <ToolRow
        icon="◆"
        label={source}
        open={open}
        onToggle={full ? () => setOpen((o) => !o) : undefined}
        event={event}
      >
        {event.text}
      </ToolRow>
      {open && full && <pre className="ev-full">{full}</pre>}
    </div>
  );
}

export function SessionStartLine({ event }: Props) {
  const branch = metaString(event, "gitBranch");
  const version = metaString(event, "version");
  return (
    <div className="ev ev-start">
      <span>
        Session started{branch ? ` on ${branch}` : ""}
        {version ? ` · Claude Code ${version}` : ""}
      </span>
      <Stamp event={event} />
    </div>
  );
}

type ToolRowProps = {
  icon: string;
  label?: string;
  hint?: string | undefined;
  open: boolean;
  onToggle: (() => void) | undefined;
  event: BatonEvent;
  children: ReactNode;
};

/** A compact monospace line that optionally expands to show more. */
function ToolRow({ icon, label, hint, open, onToggle, event, children }: ToolRowProps) {
  const body = (
    <>
      <span className="tool-icon" aria-hidden>
        {icon}
      </span>
      {label && <span className="tool-label">{label}</span>}
      <span className="tool-text">{children}</span>
      {hint && <span className="tool-hint">{hint}</span>}
      {onToggle && <Caret open={open} />}
    </>
  );
  return (
    <div className="tool-row">
      {onToggle ? (
        <button type="button" className="tool-main" aria-expanded={open} onClick={onToggle}>
          {body}
        </button>
      ) : (
        <div className="tool-main">{body}</div>
      )}
      <Stamp event={event} />
    </div>
  );
}

export function Caret({ open }: { open: boolean }) {
  return (
    <span className={`caret${open ? " open" : ""}`} aria-hidden>
      ▸
    </span>
  );
}
