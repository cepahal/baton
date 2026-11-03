import type { Note } from "./schema.js";

const AGENT_NAMES = { "claude-code": "Claude Code", codex: "Codex" } as const;

export type NoteHeader = {
  sender: string;
  to: { sessionId: string; user?: string | undefined; agent: keyof typeof AGENT_NAMES };
  /** ISO time the draft was made. */
  at: string;
};

/** A sticky note as handoff markdown. Pure; the sender edits the result. */
export function renderNote(header: NoteHeader, note: Note): string {
  const to = `${header.to.user ?? "someone"}'s ${AGENT_NAMES[header.to.agent]} session \`${header.to.sessionId.slice(0, 8)}\``;
  const out = [
    `# Sticky note from ${header.sender}`,
    "",
    `- **To:** ${to}`,
    ...(note.author ? [`- **Stuck up by:** ${note.author}`] : []),
    `- **Sent:** ${header.at}`,
    "",
    "## Note",
    "",
    note.text.trim() === "" ? "_No text._" : note.text.trim(),
    "",
  ];
  if (note.files.length > 0) {
    out.push("## Attached files", "");
    for (const f of note.files)
      out.push(`- \`${f.name.replace(/`/g, "'")}\` (${formatBytes(f.size)})`);
    out.push("", "_Saved next to this file when the handoff is accepted._", "");
  }
  return out.join("\n");
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
