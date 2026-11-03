import type { BatonEvent } from "../event.js";
import { fileTouches } from "../files/touches.js";
import { displayPath } from "../transcript/tool-format.js";
import { DOMAIN_RULES, type DomainRule } from "./rules.js";
import type { DomainClassification } from "./schema.js";

/** How many of a session's latest events the classifier looks at. */
export const DOMAIN_WINDOW = 50;

/** Signal weights, in priority order: what a session edits beats where it runs beats what it says. */
const WEIGHT = { file: 3, cwd: 2, keyword: 1 } as const;
/** Evidence that counts as "plenty": two edited files' worth. Less scales confidence down. */
const SUFFICIENT_EVIDENCE = 2 * WEIGHT.file;
/** One prompt word can't outvote an edited file, however often it is repeated. */
const MAX_KEYWORD_HITS_PER_PROMPT = 3;
const MAX_REASONS = 6;

export type ClassifyOptions = {
  /**
   * Session cwd relative to its repository root (`apps/web`), when the daemon
   * knows it. `""` means the repo root, which carries no signal.
   */
  repoRelativeCwd?: string | null;
  /** Repository root; touched paths are made relative to it. Defaults to each event's `projectPath`. */
  repoRoot?: string | null;
  /** Default `DOMAIN_WINDOW`. */
  window?: number;
};

type Label = DomainRule["label"];
type Signal = keyof typeof WEIGHT;
type Tally = Map<
  Label,
  {
    score: number;
    bySignal: Record<Signal, number>;
    reasons: Map<string, { points: number; count: number }>;
  }
>;

/**
 * Guesses what a session works on from its latest events: files it edits,
 * where it runs, and words in its prompts. Pure; rules live in `DOMAIN_RULES`.
 */
export function classifyDomain(
  events: readonly BatonEvent[],
  options: ClassifyOptions = {},
): DomainClassification {
  const recent = events.slice(-(options.window ?? DOMAIN_WINDOW));
  const tally: Tally = new Map();
  const add = (label: Label, signal: Signal, points: number, reason: string) => {
    let t = tally.get(label);
    if (!t) {
      t = { score: 0, bySignal: { file: 0, cwd: 0, keyword: 0 }, reasons: new Map() };
      tally.set(label, t);
    }
    t.score += points;
    t.bySignal[signal] += points;
    const r = t.reasons.get(reason);
    if (r) {
      r.points += points;
      r.count++;
    } else t.reasons.set(reason, { points, count: 1 });
  };

  for (const event of recent) {
    if (event.kind === "tool_call") {
      for (const path of touchedPaths(event)) {
        const rel = displayPath(path, options.repoRoot ?? event.projectPath);
        const labels = matchPath(rel);
        for (const [label, why] of labels) {
          add(label, "file", WEIGHT.file / labels.size, `edited ${rel} (${why})`);
        }
      }
    } else if (event.kind === "prompt") {
      for (const [label, words] of matchKeywords(event.text)) {
        const hits = Math.min(words.length, MAX_KEYWORD_HITS_PER_PROMPT);
        for (const word of words.slice(0, hits))
          add(label, "keyword", WEIGHT.keyword, `prompt says "${word}"`);
      }
    }
  }

  const cwd = options.repoRelativeCwd;
  if (cwd) {
    const labels = matchDirs(cwd.split(/[\\/]/));
    for (const [label, why] of labels)
      add(label, "cwd", WEIGHT.cwd / labels.size, `cwd ${cwd} (${why})`);
  }

  return decide(tally);
}

function decide(tally: Tally): DomainClassification {
  // Equal scores are settled by signal priority: edited files, then cwd.
  const ranked = [...tally.entries()].sort(
    ([, a], [, b]) =>
      b.score - a.score || b.bySignal.file - a.bySignal.file || b.bySignal.cwd - a.bySignal.cwd,
  );
  const total = ranked.reduce((sum, [, t]) => sum + t.score, 0);
  const top = ranked[0];
  if (!top || total === 0)
    return { label: "unknown", confidence: 0, reasons: ["no domain signals"] };
  const [label, best] = top;
  const second = ranked[1]?.[1];
  const share = best.score / total;
  const confidence = round(share * Math.min(1, total / SUFFICIENT_EVIDENCE));
  const reasons = [...best.reasons.entries()]
    .sort(([, a], [, b]) => b.points - a.points)
    .map(([reason, { count }]) => (count > 1 ? `${reason} ×${count}` : reason));
  const shown = reasons.slice(0, MAX_REASONS);
  if (reasons.length > shown.length) shown.push(`+${reasons.length - shown.length} more`);
  const same = (t: typeof best) =>
    t.score === best.score &&
    t.bySignal.file === best.bySignal.file &&
    t.bySignal.cwd === best.bySignal.cwd;
  if (second && same(second)) {
    const tied = ranked.filter(([, t]) => same(t)).map(([l]) => l);
    return {
      label: "unknown",
      confidence: 0,
      reasons: [`tie between ${tied.join(", ")}`, ...shown],
    };
  }
  const others = ranked.slice(1, 3).map(([l, t]) => `${l} ${round(t.score / total)}`);
  if (others.length > 0) shown.push(`also: ${others.join(", ")}`);
  return { label, confidence, reasons: shown };
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Files a tool call writes: Claude Edit/Write/MultiEdit/NotebookEdit, Codex patches. */
export function touchedPaths(event: BatonEvent): string[] {
  return fileTouches(event).map((t) => t.path);
}

/** Labels a repo-relative path matches, with why. Each label counted once per file. */
function matchPath(path: string): Map<Label, string> {
  const segments = path.split(/[\\/]/).filter((s) => s !== "" && s !== ".");
  const base = (segments.pop() ?? "").toLowerCase();
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot) : base;
  // A known directory says more than an extension shared by several domains
  // (`sql/eda.ipynb` is data work), so names only count when no directory does.
  const out = matchDirs(segments);
  if (out.size > 0) return out;
  for (const rule of DOMAIN_RULES) {
    if (rule.extensions.includes(ext)) out.set(rule.label, ext);
    else if (rule.files.some((re) => re.test(base))) out.set(rule.label, base);
  }
  return out;
}

function matchDirs(segments: readonly string[]): Map<Label, string> {
  const out = new Map<Label, string>();
  const lower = segments.map((s) => s.toLowerCase());
  for (const rule of DOMAIN_RULES) {
    const dir = lower.find((s) => rule.dirs.includes(s));
    if (dir !== undefined) out.set(rule.label, `${dir}/`);
  }
  return out;
}

/** Keywords per label found in a prompt, each counted once. */
function matchKeywords(text: string): Map<Label, string[]> {
  const words = ` ${text.toLowerCase().replace(/[^a-z0-9+#-]+/g, " ")} `;
  const out = new Map<Label, string[]>();
  for (const rule of DOMAIN_RULES) {
    const found = rule.keywords.filter((k) => words.includes(` ${k} `));
    if (found.length > 0) out.set(rule.label, found);
  }
  return out;
}
