import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { AGENT_REGISTRY, type AgentId, parseRolloutName, type SourceKind } from "@baton/core";
import { livePath } from "./log-file.js";
import { fileKey } from "./paths.js";

/** Where one agent's session logs live, and which files there are its logs. */
export type LogSource = {
  readonly agent: AgentId;
  readonly kind: SourceKind;
  readonly dir: string;
  detect(path: string): boolean;
};

export type CursorSessionInfo = {
  sessionId: string;
  projectPath: string;
  parentSessionId?: string;
};

/** Expands a registry root (`~/…`) against the home directory. */
export function expandHome(root: string, home = homedir()): string {
  if (root === "~") return home;
  return /^~[\\/]/.test(root) ? join(home, root.slice(2)) : root;
}

/** The directory an agent's logs are read from unless the user picks another. */
export function defaultSourceDir(agent: AgentId, home = homedir()): string {
  const info = AGENT_REGISTRY.find((a) => a.id === agent);
  return expandHome(info?.defaultRoots()[0] ?? "~", home);
}

/** One source per agent in the core registry; `dirs` overrides the default roots. */
export function logSources(
  dirs: Partial<Record<AgentId, string>> = {},
  home = homedir(),
): LogSource[] {
  return AGENT_REGISTRY.map((agent) => ({
    agent: agent.id,
    kind: agent.source,
    dir: dirs[agent.id] ?? defaultSourceDir(agent.id, home),
    detect: (path: string) => agent.detect(path),
  }));
}

/** Is `path` one of `source`'s logs (inside its dir, and matching its adapter)? */
export function belongsTo(source: LogSource, path: string): boolean {
  const rel = relative(source.dir, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && source.detect(path);
}

/**
 * Files that make up one session share a key. A Claude Code transcript is a
 * session on its own; a Codex thread can span several rollout files (a
 * rewind starts a segment file), all read by one adapter in order.
 */
export function sessionKey(source: LogSource, path: string): string {
  if (source.kind === "rollout-tail") {
    const name = parseRolloutName(path);
    if (name) return `${source.agent}:${name.threadId}`;
  }
  if (source.agent === "cursor") return `cursor:${cursorSessionInfo(source, path).sessionId}`;
  return logKey(path);
}

/** Cursor's transcript records don't contain their conversation id or cwd. */
export function cursorSessionInfo(source: LogSource, path: string): CursorSessionInfo {
  const rel = relative(source.dir, path).replace(/\\/g, "/");
  const parts = rel.split("/").filter(Boolean);
  const transcriptIndex = parts.findIndex((part) => part.toLowerCase() === "agent-transcripts");
  const transcriptParts = transcriptIndex < 0 ? [] : parts.slice(transcriptIndex + 1);
  const leaf = transcriptParts.at(-1) ?? path.split(/[\\/]/).at(-1) ?? "cursor-session.jsonl";
  const sessionId = leaf.replace(/\.jsonl$/i, "") || "cursor-session";
  const parentSessionId =
    transcriptParts.length >= 3 && transcriptParts.at(-2)?.toLowerCase() === "subagents"
      ? transcriptParts.at(-3)
      : undefined;
  const projectSlug = transcriptIndex > 0 ? parts[transcriptIndex - 1] : parts[0];
  return {
    sessionId,
    projectPath: decodeCursorProjectSlug(projectSlug ?? ""),
    ...(parentSessionId ? { parentSessionId } : {}),
  };
}

/** Decodes the folder Cursor uses for a workspace under `~/.cursor/projects`. */
export function decodeCursorProjectSlug(
  slug: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    const drive = /^([a-z])-(.*)$/i.exec(slug);
    if (drive?.[1] && drive[2]) {
      const path = drive[2].replace(/-/g, "\\");
      return `${drive[1].toUpperCase()}:\\${path}`;
    }
  }
  return `/${slug.replace(/^-+/, "").replace(/-/g, "/")}`;
}

/** State-store key of one log file; a `.zst` shares its original's key. */
export const logKey = (path: string): string => fileKey(livePath(path));
