import { type Draft, meta } from "../draft.js";
import type { JsonValue } from "../event.js";
import { displayPath, oneLine, summarizeText } from "../transcript/tool-format.js";
import type { CommandExecutionItem, FileChangeItem, McpToolCallItem } from "./records.js";

/**
 * Codex tool items → a `tool_call` and a `tool_result` draft. Codex reports a
 * call and its result in one completed item. Formats are in the "Codex
 * adapter" section of docs/spec.md.
 */

export type ToolDrafts = [call: Draft, result: Draft];

const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? "" : "s"}`;

const nonEmptyLines = (text: string): string[] =>
  text.split(/\r?\n/).filter((l) => l.trim() !== "");

const lineCount = (text: string): number => (text === "" ? 0 : text.split(/\r?\n/).length);

/** `file:///C:/a/b` → `C:/a/b`, `file:///home/a` → `/home/a`. Other strings unchanged. */
export function fileUrlToPath(url: string): string {
  if (!url.startsWith("file://")) return url;
  let p = url.slice("file://".length);
  try {
    p = decodeURIComponent(p);
  } catch {
    // Keep the raw text if it isn't valid percent-encoding.
  }
  return /^\/[A-Za-z]:\//.test(p) ? p.slice(1) : p;
}

const SHELLS = new Set(["pwsh", "powershell", "bash", "sh", "zsh", "dash", "fish", "cmd"]);
const SCRIPT_FLAGS = new Set(["-command", "-c", "-lc", "/c"]);

/** What a shell command runs: the script for `<shell> -Command <script>`, else argv joined. */
export function shellScript(command: string[] | string): string {
  if (typeof command === "string") return command;
  const exe = (command[0] ?? "")
    .replace(/^["']|["']$/g, "")
    .split(/[\\/]/)
    .pop()
    ?.toLowerCase()
    .replace(/\.exe$/, "");
  if (exe && SHELLS.has(exe)) {
    const flag = command.findIndex((a, i) => i > 0 && SCRIPT_FLAGS.has(a.toLowerCase()));
    const script = flag > 0 ? command[flag + 1] : undefined;
    if (script !== undefined) return script;
  }
  return command.join(" ");
}

const firstLine = (s: string): string => nonEmptyLines(s)[0]?.trim() ?? "";

function toolDrafts(
  name: string,
  args: string,
  toolUseId: string,
  input: Record<string, JsonValue>,
  result: { outcome: string; isError: boolean; full?: string; nonText?: number },
): ToolDrafts {
  const head = args ? `${name} ${args}` : name;
  const full = result.full;
  return [
    { kind: "tool_call", text: oneLine(head), meta: { toolName: name, toolUseId, input } },
    {
      kind: "tool_result",
      text: oneLine(result.outcome.startsWith(" ") ? `${head}${result.outcome}` : result.outcome),
      meta: meta({
        toolUseId,
        toolName: name,
        isError: result.isError,
        lines: full === undefined ? 0 : lineCount(full),
        nonText: result.nonText,
        full,
      }),
    },
  ];
}

const failed = (status: string | undefined): boolean =>
  status !== undefined && status !== "completed";

export function shellDrafts(item: CommandExecutionItem): ToolDrafts {
  const code = item.exit_code ?? undefined;
  const isError = failed(item.status) || (code !== undefined && code !== 0);
  const full = item.aggregated_output ?? "";
  const n = nonEmptyLines(full).length;
  const status = code !== undefined ? `exit ${code}` : isError ? "error" : "exit 0";
  return toolDrafts(
    "Shell",
    firstLine(shellScript(item.command)),
    item.id,
    meta({ command: item.command, cwd: item.cwd }),
    {
      outcome: `Shell → ${status}, ${n === 0 ? "no output" : plural(n, "line")}`,
      isError,
      full,
    },
  );
}

export function patchDrafts(item: FileChangeItem, cwd: string | undefined): ToolDrafts {
  const paths = Object.keys(item.changes);
  const first = paths[0];
  const args =
    first === undefined
      ? ""
      : `${displayPath(first, cwd)}${paths.length > 1 ? ` (+${plural(paths.length - 1, "file")})` : ""}`;
  const isError = failed(item.status);
  const stdout = item.stdout ?? "";
  const stderr = item.stderr ?? "";
  const full = [stdout, stderr].filter((s) => s.trim() !== "").join("\n");
  const reason = firstLine(stderr) || firstLine(stdout) || "(no message)";
  return toolDrafts("Patch", args, item.id, item.changes, {
    outcome: isError ? ` → error: ${reason}` : " → ok",
    isError,
    full,
  });
}

export function mcpDrafts(item: McpToolCallItem): ToolDrafts {
  const name = `mcp__${item.server}__${item.tool}`;
  const a = item.arguments;
  const empty =
    a === undefined || a === null || (typeof a === "object" && Object.keys(a).length === 0);
  const texts: string[] = [];
  let nonText = 0;
  for (const p of item.result?.content ?? []) {
    if (p.type === "text" && p.text !== undefined) texts.push(p.text);
    else nonText++;
  }
  const error =
    item.error === undefined || item.error === null
      ? ""
      : typeof item.error === "string"
        ? item.error
        : JSON.stringify(item.error);
  const isError = failed(item.status) || error !== "";
  const full = [...texts, error].filter((s) => s !== "").join("\n");
  const recap = summarizeText(full);
  const attachments = nonText > 0 ? plural(nonText, "attachment") : "";
  return toolDrafts(
    name,
    empty ? "" : JSON.stringify(a),
    item.id,
    { arguments: a ?? null },
    {
      outcome: isError
        ? ` → error: ${recap || "(no message)"}`
        : ` → ${recap || attachments || "no output"}`,
      isError,
      full,
      ...(nonText > 0 ? { nonText } : {}),
    },
  );
}

export function viewImageDrafts(id: string, url: string, cwd: string | undefined): ToolDrafts {
  const path = fileUrlToPath(url);
  return toolDrafts(
    "ViewImage",
    displayPath(path, cwd),
    id,
    { path },
    {
      outcome: " (1 attachment)",
      isError: false,
      nonText: 1,
    },
  );
}
