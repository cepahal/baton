import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type AgentId, cursorTimestamp, sniffAgent } from "@baton/core";
import type { Logger } from "pino";

export type ReplayOptions = {
  /** Session log (`.jsonl`) to replay: a Claude Code transcript or a Codex rollout. */
  fixture: string;
  /** Claude Code projects directory to write into, as a daemon would watch it. */
  projectsDir?: string | undefined;
  /** Codex sessions directory to write into, as a daemon would watch it. */
  codexDir?: string | undefined;
  /** Cursor projects directory to write into, as a daemon would watch it. */
  cursorDir?: string | undefined;
  /** Recorded gaps are divided by this. */
  speed: number;
  /** Simulated user: replaces the home-directory username in paths, and labels the run. */
  as: string;
  /** Plays the session as if it ran in this folder: the recorded working directory is replaced everywhere. */
  cwd?: string;
  /** Longest pause, in ms after scaling; longer recorded gaps are cut to it. */
  maxGapMs?: number | undefined;
  /** Seeds the new UUIDs, so a run can be reproduced. Default random. */
  seed?: string | undefined;
  logger: Logger;
  signal?: AbortSignal | undefined;
  /** Clock, for tests. */
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

/** One line to write, `delayMs` after the replay starts. */
export type PlannedLine = { delayMs: number; text: string };

export type ReplayPlan = {
  agent: AgentId;
  sessionId: string;
  /**
   * Claude Code: `<projectsDir>/<slug>/<sessionId>.jsonl`.
   * Codex: `<codexDir>/YYYY/MM/DD/rollout-<start time>-<threadId>.jsonl`.
   */
  file: string;
  lines: PlannedLine[];
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** Home-directory usernames in Windows paths, POSIX paths, and project slugs. */
const HOME_USER = /(Users[\\/]+|Users-|\/home\/+)([^\\/\s"'-]+)/g;

/**
 * Plans a replay: every UUID gets a fresh one (consistently, so `parentUuid`
 * chains and the session id still line up, and replaying a fixture twice gives
 * two distinct sessions), the home-directory username becomes `as`, and each
 * line's delay and `timestamp` follow the recorded timestamps divided by
 * `speed`. Timestamps that go backwards are kept relative (written straight
 * away). Lines that aren't JSON are written unchanged, as Claude Code might.
 * The fixture's agent is sniffed from its first record; its directory option
 * must be set.
 */
export function planReplay(
  fixtureText: string,
  options: Pick<
    ReplayOptions,
    "projectsDir" | "codexDir" | "cursorDir" | "speed" | "as" | "maxGapMs" | "cwd"
  > & {
    seed: string;
    startMs: number;
  },
): ReplayPlan {
  if (!(options.speed > 0)) throw new RangeError("speed must be positive");
  const agent = sniffAgent(fixtureText) ?? "claude-code";
  const root =
    agent === "codex"
      ? options.codexDir
      : agent === "cursor"
        ? options.cursorDir
        : options.projectsDir;
  if (root === undefined) {
    const flag =
      agent === "codex" ? "--codex-dir" : agent === "cursor" ? "--cursor-dir" : "--projects-dir";
    throw new Error(`this fixture is a ${agent} session: replaying it needs ${flag}`);
  }
  const uuids = new Map<string, string>();
  const mapUuid = (uuid: string) => {
    const key = uuid.toLowerCase();
    let mapped = uuids.get(key);
    if (!mapped) {
      mapped = derivedUuid(options.seed, key);
      uuids.set(key, mapped);
    }
    return mapped;
  };
  const user = pathSafe(options.as);
  const rehome = (s: string) =>
    s.replace(UUID, mapUuid).replace(HOME_USER, (_m, prefix: string) => `${prefix}${user}`);
  const recorded =
    recordedCwd(fixtureText, rehome) ??
    (agent === "cursor" ? recordedCursorCwd(fixtureText, rehome) : undefined);
  const fromCwd = options.cwd === undefined ? undefined : recorded;
  const toCwd = options.cwd;
  const rewrite =
    fromCwd === undefined || toCwd === undefined
      ? rehome
      : (s: string) => rehome(s).split(fromCwd).join(toCwd);

  const maxGap = options.maxGapMs ?? Number.POSITIVE_INFINITY;
  let firstTs: number | undefined;
  let latestTs = 0;
  let elapsed = 0;
  let sessionId: string | undefined;
  let cwd: string | undefined;
  const lines: PlannedLine[] = [];

  for (const raw of fixtureText.split(/\r?\n/)) {
    if (raw.trim() === "") continue;
    let record: unknown;
    try {
      record = JSON.parse(raw);
    } catch {
      lines.push({ delayMs: elapsed, text: raw });
      continue;
    }
    let value = mapStrings(record, rewrite);
    let offset = 0;
    const cursorTs = agent === "cursor" ? cursorTimestamp(JSON.stringify(value)) : undefined;
    const recordTimestamp =
      isObject(value) && typeof value.timestamp === "string" ? value.timestamp : cursorTs;
    if (recordTimestamp) {
      const ts = Date.parse(recordTimestamp);
      if (!Number.isNaN(ts)) {
        if (firstTs === undefined) {
          firstTs = ts;
          latestTs = ts;
        }
        if (ts > latestTs) {
          elapsed += Math.min((ts - latestTs) / options.speed, maxGap);
          latestTs = ts;
        }
        // Out-of-order records keep their (scaled) distance behind the latest one.
        offset = (ts - latestTs) / options.speed;
        const replayTs = new Date(options.startMs + elapsed + offset).toISOString();
        if (isObject(value) && typeof value.timestamp === "string") value.timestamp = replayTs;
        else if (agent === "cursor") {
          value = mapStrings(value, (s) =>
            s.replace(/<timestamp>[\s\S]*?<\/timestamp>/i, `<timestamp>${replayTs}</timestamp>`),
          );
        }
      }
    }
    if (isObject(value)) {
      if (sessionId === undefined && typeof value.sessionId === "string")
        sessionId = value.sessionId;
      if (cwd === undefined && typeof value.cwd === "string") cwd = value.cwd;
      // Codex: the thread id is in the first session_meta.
      const payload = value.payload;
      if (sessionId === undefined && value.type === "session_meta" && isObject(payload)) {
        if (typeof payload.id === "string") sessionId = payload.id;
      }
    }
    lines.push({ delayMs: Math.round(elapsed), text: JSON.stringify(value) });
  }

  const session = sessionId ?? derivedUuid(options.seed, "session");
  if (agent === "codex") {
    return { agent, sessionId: session, file: rolloutPath(root, session, options.startMs), lines };
  }
  const replayCwd = options.cwd ?? cwd ?? recorded;
  const slug = replayCwd?.replace(/^[\\/]+/, "").replace(/[^A-Za-z0-9]/g, "-") ?? "replay";
  const file =
    agent === "cursor"
      ? join(root, slug, "agent-transcripts", session, `${session}.jsonl`)
      : join(root, slug, `${session}.jsonl`);
  return { agent, sessionId: session, file, lines };
}

/** Where Codex would put a new thread's rollout, by its start time (UTC here). */
function rolloutPath(codexDir: string, threadId: string, startMs: number): string {
  const iso = new Date(startMs).toISOString();
  const [y = "", m = "", d = ""] = iso.slice(0, 10).split("-");
  const time = iso.slice(0, 19).replace(/:/g, "-");
  return join(codexDir, y, m, d, `rollout-${time}-${threadId}.jsonl`);
}

/** The first working directory a transcript records (Claude `cwd`, Codex `payload.cwd`), rewritten. */
export function recordedCwd(
  fixtureText: string,
  rewrite: (s: string) => string,
): string | undefined {
  for (const raw of fixtureText.split(/\r?\n/)) {
    if (raw.trim() === "") continue;
    let record: unknown;
    try {
      record = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isObject(record)) continue;
    if (typeof record.cwd === "string" && record.cwd !== "") return rewrite(record.cwd);
    const payload = record.payload;
    if (isObject(payload) && typeof payload.cwd === "string" && payload.cwd !== "") {
      return rewrite(payload.cwd);
    }
  }
  return undefined;
}

function recordedCursorCwd(
  fixtureText: string,
  rewrite: (s: string) => string,
): string | undefined {
  for (const raw of fixtureText.split(/\r?\n/)) {
    if (raw.trim() === "") continue;
    let record: unknown;
    try {
      record = JSON.parse(raw);
    } catch {
      continue;
    }
    const cwd = findWorkingDirectory(record);
    if (cwd) return rewrite(cwd);
  }
  return undefined;
}

function findWorkingDirectory(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findWorkingDirectory(child);
      if (found) return found;
    }
    return undefined;
  }
  if (!isObject(value)) return undefined;
  for (const key of ["working_directory", "cwd"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate !== "") return candidate;
  }
  for (const child of Object.values(value)) {
    const found = findWorkingDirectory(child);
    if (found) return found;
  }
  return undefined;
}

/**
 * `baton replay`: writes a fixture into a fresh session log at its recorded
 * pace, so a watching daemon sees what looks like a live Claude Code, Codex or Cursor
 * session.
 * Resolves when every line is written (or rejects with the signal's reason).
 */
export async function runReplay(options: ReplayOptions): Promise<ReplayPlan> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  const text = await readFile(options.fixture, "utf8");
  const startMs = now();
  const plan = planReplay(text, {
    projectsDir: options.projectsDir,
    codexDir: options.codexDir,
    cursorDir: options.cursorDir,
    speed: options.speed,
    as: options.as,
    maxGapMs: options.maxGapMs,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    seed: options.seed ?? randomUUID(),
    startMs,
  });
  const log = options.logger.child({ session: plan.sessionId, as: options.as });
  const last = plan.lines.at(-1);
  log.info(
    {
      agent: plan.agent,
      file: plan.file,
      lines: plan.lines.length,
      seconds: Math.round((last?.delayMs ?? 0) / 1000),
    },
    "replaying transcript",
  );

  await mkdir(join(plan.file, ".."), { recursive: true });
  // A fresh file: replaying with the same seed starts the session over.
  await writeFile(plan.file, "");
  let i = 0;
  while (i < plan.lines.length) {
    options.signal?.throwIfAborted();
    const due = plan.lines[i]?.delayMs ?? 0;
    const wait = startMs + due - now();
    if (wait > 0) await sleep(wait, options.signal);
    // Everything due by now goes out in one write, like a burst from Claude Code.
    const batch: string[] = [];
    while (i < plan.lines.length && startMs + (plan.lines[i]?.delayMs ?? 0) <= now()) {
      batch.push(`${plan.lines[i]?.text}\n`);
      i++;
    }
    if (batch.length > 0) await appendFile(plan.file, batch.join(""));
  }
  log.info({ file: plan.file }, "replay finished");
  return plan;
}

/** A v4-shaped UUID derived from a seed and a name. */
function derivedUuid(seed: string, name: string): string {
  const h = createHash("sha256").update(`${seed}\0${name}`).digest("hex");
  const variant = ((Number.parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Characters safe in a path segment and a project slug. */
function pathSafe(name: string): string {
  const clean = name.replace(/[^A-Za-z0-9._]/g, "_");
  return clean === "" ? "user" : clean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Copies a JSON value, passing every string (values and keys) through `f`. */
function mapStrings(value: unknown, f: (s: string) => string): unknown {
  if (typeof value === "string") return f(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, f));
  if (isObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[f(k)] = mapStrings(v, f);
    return out;
  }
  return value;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      reject(signal?.reason);
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}
