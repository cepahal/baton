/**
 * Splits the text of a `user` transcript record into what the user actually
 * typed (or pasted) and what Claude Code injected around it.
 */

/** How a piece of user-side content is labelled. See docs/spec.md. */
export type UserContentLabel = "prompt" | "tool_result" | "system";

export type UserTextSegment = {
  label: "prompt" | "system";
  /** prompt: typed | pasted | slash_command | bash. system: the injecting tag, or interrupt. */
  source: string;
  text: string;
};

/** Tags Claude Code wraps around content the user did not type. */
const INJECTED_TAGS = [
  "system-reminder",
  "ide_opened_file",
  "ide_selection",
  "ide_diagnostics",
  "local-command-caveat",
  "local-command-stdout",
  "local-command-stderr",
  "bash-stdout",
  "bash-stderr",
  "task-notification",
  "user-prompt-submit-hook",
] as const;

/** Tags around content the user did produce. */
const TYPED_TAGS = [
  "pasted_content",
  "bash-input",
  "command-name",
  "command-message",
  "command-args",
];

const TAG_RE = new RegExp(
  `<(${[...INJECTED_TAGS, ...TYPED_TAGS].join("|")})\\b[^>]*>([\\s\\S]*?)</\\1\\b[^>]*>`,
  "g",
);

const PASTE_OPEN_RE = /<pasted_content\b[^>]*>/g;
const PASTE_CLOSE_RE = /<\/pasted_content\b/;

/** Finds a trailing `<pasted_content>` opener that is never closed (e.g. a truncated record). */
function findUnclosedPaste(text: string): { start: number; inner: string } | undefined {
  const opener = [...text.matchAll(PASTE_OPEN_RE)].at(-1);
  if (!opener) return undefined;
  const inner = text.slice(opener.index + opener[0].length);
  return PASTE_CLOSE_RE.test(inner) ? undefined : { start: opener.index, inner };
}

const INTERRUPT_RE = /^\[Request interrupted by user[^\]]*\]$/;

/**
 * Splits user text into labelled segments, in order. Text inside
 * `<pasted_content>` is kept verbatim, even if it contains injected-looking tags.
 * An unclosed `<pasted_content>` runs to the end of the text.
 * Adjacent prompt segments are not merged here; see {@link mergePromptSegments}.
 */
export function segmentUserText(text: string): UserTextSegment[] {
  const out: UserTextSegment[] = [];
  let slash: { segment: UserTextSegment; name: string; args: string } | undefined;
  let last = 0;

  const typed = (chunk: string) => {
    if (chunk.trim() === "") {
      if (chunk) out.push({ label: "prompt", source: "typed", text: chunk });
      return;
    }
    if (INTERRUPT_RE.test(chunk.trim())) {
      out.push({ label: "system", source: "interrupt", text: chunk.trim() });
    } else {
      out.push({ label: "prompt", source: "typed", text: chunk });
    }
  };

  const unclosed = findUnclosedPaste(text);
  const body = unclosed ? text.slice(0, unclosed.start) : text;

  for (const m of body.matchAll(TAG_RE)) {
    typed(body.slice(last, m.index));
    last = m.index + m[0].length;
    const tag = m[1] ?? "";
    const inner = m[2] ?? "";

    if (tag === "pasted_content") {
      out.push({ label: "prompt", source: "pasted", text: inner.trim() });
    } else if (tag === "bash-input") {
      out.push({ label: "prompt", source: "bash", text: `!${inner.trim()}` });
    } else if (tag.startsWith("command-")) {
      if (!slash) {
        slash = {
          segment: { label: "prompt", source: "slash_command", text: "" },
          name: "",
          args: "",
        };
        out.push(slash.segment);
      }
      if (tag === "command-name") slash.name = inner.trim();
      if (tag === "command-args") slash.args = inner.trim();
    } else {
      out.push({ label: "system", source: tag, text: inner.trim() });
    }
  }
  typed(body.slice(last));
  if (unclosed) out.push({ label: "prompt", source: "pasted", text: unclosed.inner.trim() });

  if (slash) slash.segment.text = [slash.name, slash.args].filter(Boolean).join(" ");
  return out.filter((s) => s.label === "prompt" || s.text !== "");
}

/**
 * Merges every prompt segment of one record into a single prompt, keeping
 * system segments separate. The prompt takes the position of its first
 * segment. Returns no prompt if the typed text is empty.
 */
export function mergePromptSegments(
  segments: UserTextSegment[],
): (
  | { label: "prompt"; text: string; sources: string[] }
  | (UserTextSegment & { label: "system" })
)[] {
  const out: ReturnType<typeof mergePromptSegments> = [];
  const prompt = { label: "prompt" as const, text: "", sources: [] as string[] };
  let placed = false;

  for (const s of segments) {
    if (s.label === "system") {
      out.push({ ...s, label: "system" });
      continue;
    }
    if (!placed && s.text.trim() !== "") {
      out.push(prompt);
      placed = true;
    }
    prompt.text += s.source === "pasted" ? `\n${s.text}\n` : s.text;
    if (s.text.trim() !== "" && !prompt.sources.includes(s.source)) prompt.sources.push(s.source);
  }
  prompt.text = prompt.text.trim();
  return out;
}
