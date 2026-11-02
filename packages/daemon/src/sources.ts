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
  return logKey(path);
}

/** State-store key of one log file; a `.zst` shares its original's key. */
export const logKey = (path: string): string => fileKey(livePath(path));
