import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";

export type ReplayOptions = {
  /** Transcript (`.jsonl`) to replay. */
  fixture: string;
  /** Projects directory to write into, as a daemon would watch it. */
  projectsDir: string;
  /** Recorded gaps are divided by this. */
  speed: number;
  /** Simulated user: replaces the home-directory username in paths, and labels the run. */
  as: string;
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
  sessionId: string;
  /** `<projectsDir>/<slug>/<sessionId>.jsonl` */
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
 */
export function planReplay(
  fixtureText: string,
  options: Pick<ReplayOptions, "projectsDir" | "speed" | "as" | "maxGapMs"> & {
    seed: string;
    startMs: number;
  },
): ReplayPlan {
  if (!(options.speed > 0)) throw new RangeError("speed must be positive");
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
  const rewrite = (s: string) =>
    s.replace(UUID, mapUuid).replace(HOME_USER, (_m, prefix: string) => `${prefix}${user}`);

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
    const value = mapStrings(record, rewrite);
    let offset = 0;
    if (isObject(value) && typeof value.timestamp === "string") {
      const ts = Date.parse(value.timestamp);
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
        value.timestamp = new Date(options.startMs + elapsed + offset).toISOString();
      }
    }
    if (isObject(value)) {
      if (sessionId === undefined && typeof value.sessionId === "string")
        sessionId = value.sessionId;
      if (cwd === undefined && typeof value.cwd === "string") cwd = value.cwd;
    }
    lines.push({ delayMs: Math.round(elapsed), text: JSON.stringify(value) });
  }

  const session = sessionId ?? derivedUuid(options.seed, "session");
  const slug = cwd ? cwd.replace(/[^A-Za-z0-9]/g, "-") : "replay";
  return { sessionId: session, file: join(options.projectsDir, slug, `${session}.jsonl`), lines };
}

/**
 * `baton replay`: writes a fixture into a fresh transcript file at its recorded
 * pace, so a watching daemon sees what looks like a live Claude Code session.
 * Resolves when every line is written (or rejects with the signal's reason).
 */
export async function runReplay(options: ReplayOptions): Promise<ReplayPlan> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  const text = await readFile(options.fixture, "utf8");
  const startMs = now();
  const plan = planReplay(text, {
    projectsDir: options.projectsDir,
    speed: options.speed,
    as: options.as,
    maxGapMs: options.maxGapMs,
    seed: options.seed ?? randomUUID(),
    startMs,
  });
  const log = options.logger.child({ session: plan.sessionId, as: options.as });
  const last = plan.lines.at(-1);
  log.info(
    { file: plan.file, lines: plan.lines.length, seconds: Math.round((last?.delayMs ?? 0) / 1000) },
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
