import { createCodexParser } from "../codex/parser.js";
import { AGENT_IDS, type AgentId, type BatonEvent } from "../event.js";
import {
  createTranscriptParser,
  type ParseResult,
  type ParserOptions,
  type ParseWarning,
} from "../transcript/parser.js";

/** How the daemon gets an agent's records off disk. See "Sources" in docs/spec.md. */
export type SourceKind = "jsonl-tail" | "rollout-tail";

/**
 * One coding agent's log format. Pure: the daemon owns the files and feeds
 * `parse` one session's lines in order. One instance per session.
 */
export interface AgentAdapter {
  readonly id: AgentId;
  readonly source: SourceKind;
  /** Where the agent writes session logs, home-relative (`~/…`). */
  defaultRoots(): string[];
  /** Whether a path is one of this agent's session logs. Looks only at the string. */
  detect(path: string): boolean;
  /** One raw log line → 0..n events. Never throws. */
  parse(record: string): BatonEvent[];
}

const basename = (path: string): string => path.split(/[\\/]/).pop() ?? path;

/** `rollout-<time>-<threadId>[_<segmentId>].jsonl[.zst]` */
const CODEX_ROLLOUT_RE = /^rollout-.+\.jsonl(?:\.zst)?$/i;

const isCodexRollout = (path: string): boolean => CODEX_ROLLOUT_RE.test(basename(path));
const isClaudeTranscript = (path: string): boolean =>
  /\.jsonl$/i.test(path) && !isCodexRollout(path);

/** An adapter's static description: everything but the parser. */
export type AgentInfo = Omit<AgentAdapter, "parse">;

const AGENTS: Record<AgentId, AgentInfo> = {
  "claude-code": {
    id: "claude-code",
    source: "jsonl-tail",
    defaultRoots: () => ["~/.claude/projects"],
    detect: isClaudeTranscript,
  },
  codex: {
    id: "codex",
    source: "rollout-tail",
    defaultRoots: () => ["~/.codex/sessions"],
    detect: isCodexRollout,
  },
};

/** Every agent Baton can follow; the daemon starts one source per entry. */
export const AGENT_REGISTRY: readonly AgentInfo[] = AGENT_IDS.map((id) => AGENTS[id]);

/** A fresh adapter (and parser state) for one session of agent `id`. */
export function createAdapter(id: AgentId, options: ParserOptions = {}): AgentAdapter {
  const parser = id === "codex" ? createCodexParser(options) : createTranscriptParser(options);
  return { ...AGENTS[id], parse: (record) => parser.parseLine(record) };
}

/** The agent whose session log `path` is, if any. Codex is checked first: its names are stricter. */
export function detectAgent(path: string): AgentId | undefined {
  if (AGENTS.codex.detect(path)) return "codex";
  if (AGENTS["claude-code"].detect(path)) return "claude-code";
  return undefined;
}

/** Parses a whole session log of agent `id`, collecting warnings. */
export function parseSession(
  id: AgentId,
  text: string,
  options: Pick<ParserOptions, "debug"> = {},
): ParseResult {
  const warnings: ParseWarning[] = [];
  const adapter = createAdapter(id, { ...options, onWarning: (w) => warnings.push(w) });
  const events: BatonEvent[] = [];
  for (const line of text.split(/\r?\n/)) events.push(...adapter.parse(line));
  return { events, warnings };
}

const CODEX_RECORD_TYPES = new Set([
  "session_meta",
  "turn_context",
  "event_msg",
  "response_item",
  "compacted",
]);

/**
 * The agent that wrote a session log, judged by its first JSON record: Codex
 * rollout lines are `{ type, payload }` envelopes; anything else with a `type`
 * is taken as Claude Code. `undefined` when no line is a JSON object with a type.
 */
export function sniffAgent(text: string): AgentId | undefined {
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record !== "object" || record === null || Array.isArray(record)) continue;
    const type: unknown = Reflect.get(record, "type");
    if (typeof type !== "string") continue;
    const payload: unknown = Reflect.get(record, "payload");
    const envelope = typeof payload === "object" && payload !== null;
    return envelope && CODEX_RECORD_TYPES.has(type) ? "codex" : "claude-code";
  }
  return undefined;
}
