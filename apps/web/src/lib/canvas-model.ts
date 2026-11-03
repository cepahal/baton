import type {
  CanvasPoint,
  CanvasPositions,
  DomainLabel,
  SessionInfo,
  TouchedFile,
} from "@baton/core";

/** Session card size on the canvas, px. */
export const CARD_W = 236;
export const CARD_H = 132;
/** Space a repo group leaves around its cards: header height and padding. */
export const GROUP_HEAD = 44;
export const GROUP_PAD = 16;
/** A card joining cards of its repo lands this far (corner to corner) from one of them. */
export const SPAWN_DISTANCE = 2 * CARD_W;

type KnownDomain = Exclude<DomainLabel, "unknown">;

/**
 * Domain pairs with a distinct flow between them, upstream first: a link
 * between such sessions gets an arrow pointing downstream.
 */
export const DOMAIN_FLOWS: readonly (readonly [KnownDomain, KnownDomain])[] = [
  ["frontend", "backend"],
  ["backend", "data"],
  ["backend", "ml"],
  ["data", "ml"],
];

export type CanvasCard = {
  /** Canvas key: `session:<sessionId>`. */
  key: string;
  groupKey: string;
  session: SessionInfo;
  /** Top-left corner, in canvas coordinates. */
  position: CanvasPoint;
  /** The domain to show; undefined when it couldn't be determined (shown blank). */
  domain: { label: KnownDomain; confidence: number; manual: boolean } | undefined;
};

export type CanvasGroup = {
  /** `repo:<repoId>`, or `repo:dir:<projectPath>` outside git. */
  key: string;
  title: string;
  /** Full repoId, or the folder for sessions outside git. */
  subtitle: string;
  /** The box drawn around the group's cards. */
  position: CanvasPoint;
  width: number;
  height: number;
  cards: CanvasCard[];
};

export type LinkLevel = "none" | "file" | "lines";

export type CanvasLink = {
  key: string;
  /** The upstream card when the link has a direction. */
  source: string;
  target: string;
  label: string;
  /** Files both sessions wrote (repo-relative). */
  shared: string[];
  /** `lines`: some shared file's written line ranges overlap; `file`: only files in common. */
  level: LinkLevel;
  /** The two domains form a flow (see `DOMAIN_FLOWS`), from source to target. */
  directed: boolean;
};

export type CanvasModel = { groups: CanvasGroup[]; links: CanvasLink[] };

export const cardKey = (sessionId: string) => `session:${sessionId}`;

/**
 * The canvas: every session with a saved position, as a card where it was put,
 * grouped by repo, each group's cards linked to one another. A session appears
 * at most once, however many times it's listed.
 */
export function buildCanvas(
  sessions: readonly SessionInfo[],
  positions: CanvasPositions,
): CanvasModel {
  const groups = new Map<string, { title: string; subtitle: string; cards: CanvasCard[] }>();
  for (const session of dedupe(sessions)) {
    const key = cardKey(session.sessionId);
    const position = positions[key];
    if (!position) continue;
    const gk = groupKey(session);
    let g = groups.get(gk);
    if (!g) {
      g = { ...groupTitle(session), cards: [] };
      groups.set(gk, g);
    }
    g.cards.push({ key, groupKey: gk, session, position, domain: cardDomain(session) });
  }
  const out: CanvasGroup[] = [];
  for (const [key, g] of groups) {
    g.cards.sort((a, b) => a.key.localeCompare(b.key));
    out.push({ key, title: g.title, subtitle: g.subtitle, cards: g.cards, ...groupBox(g.cards) });
  }
  return { groups: out, links: out.flatMap((g) => linksIn(g.cards)) };
}

/** The box around a group's cards, leaving room for the header. */
export function groupBox(
  cards: readonly Pick<CanvasCard, "position">[],
): Pick<CanvasGroup, "position" | "width" | "height"> {
  const xs = cards.map((c) => c.position.x);
  const ys = cards.map((c) => c.position.y);
  const x = Math.min(...xs) - GROUP_PAD;
  const y = Math.min(...ys) - GROUP_HEAD;
  return {
    position: { x, y },
    width: Math.max(...xs) + CARD_W + GROUP_PAD - x,
    height: Math.max(...ys) + CARD_H + GROUP_PAD - y,
  };
}

/**
 * Where a session dropped at `drop` (canvas coordinates) goes. The card is
 * centred where it's dropped, unless its repo already has cards on the
 * canvas: then it lands `SPAWN_DISTANCE` from the one nearest the drop, in a
 * random direction that doesn't cover another card. `random` returns [0, 1).
 */
export function placeDrop(
  session: SessionInfo,
  drop: CanvasPoint,
  model: CanvasModel,
  random: () => number = Math.random,
): CanvasPoint {
  const key = cardKey(session.sessionId);
  const others = model.groups.flatMap((g) => g.cards).filter((c) => c.key !== key);
  const siblings = others.filter((c) => c.groupKey === groupKey(session));
  const centred = { x: drop.x - CARD_W / 2, y: drop.y - CARD_H / 2 };
  const [first, ...rest] = siblings;
  if (!first) return round(centred);

  const distance = (c: CanvasCard) =>
    Math.hypot(c.position.x - centred.x, c.position.y - centred.y);
  const anchor = rest.reduce((best, c) => (distance(c) < distance(best) ? c : best), first);
  let spot = centred;
  for (let attempt = 0; attempt < 24; attempt++) {
    const angle = random() * 2 * Math.PI;
    spot = {
      x: anchor.position.x + Math.cos(angle) * SPAWN_DISTANCE,
      y: anchor.position.y + Math.sin(angle) * SPAWN_DISTANCE,
    };
    if (!others.some((c) => overlaps(c.position, spot))) break;
  }
  return round(spot);
}

const round = (p: CanvasPoint): CanvasPoint => ({ x: Math.round(p.x), y: Math.round(p.y) });

/** Cards with these top-left corners would overlap (with some breathing room). */
const overlaps = (a: CanvasPoint, b: CanvasPoint) =>
  Math.abs(a.x - b.x) < CARD_W + 24 && Math.abs(a.y - b.y) < CARD_H + 24;

/** One entry per sessionId: the most recently active. */
export function dedupe(sessions: readonly SessionInfo[]): SessionInfo[] {
  const byId = new Map<string, SessionInfo>();
  for (const s of sessions) {
    const prev = byId.get(s.sessionId);
    if (!prev || s.lastActivity > prev.lastActivity) byId.set(s.sessionId, s);
  }
  return [...byId.values()];
}

export function groupKey(s: SessionInfo): string {
  const id = s.repo?.repoId;
  return id ? `repo:${id}` : `repo:dir:${s.projectPath}`;
}

/** `github.com/org/app` → `app`; a root-commit id → the repo folder's name. */
export function groupTitle(s: SessionInfo): { title: string; subtitle: string } {
  const id = s.repo?.repoId;
  if (!id) return { title: lastSegment(s.projectPath) || s.projectName, subtitle: s.projectPath };
  if (/^[0-9a-f]{7,64}$/.test(id)) {
    const root = repoRootOf(s.projectPath, s.repo?.relativeCwd ?? "");
    return { title: lastSegment(root) || s.projectName, subtitle: `root ${id.slice(0, 10)}` };
  }
  return { title: lastSegment(id) || id, subtitle: id };
}

/** What a card shows for the domain: nothing when it's unknown. */
export function cardDomain(s: SessionInfo): CanvasCard["domain"] {
  const d = s.domain;
  if (!d || d.label === "unknown") return undefined;
  return { label: d.label, confidence: d.confidence, manual: d.source === "override" };
}

/** Which way work flows between two domains, if it clearly does. */
export function flowBetween(
  a: DomainLabel | undefined,
  b: DomainLabel | undefined,
): "forward" | "backward" | undefined {
  for (const [up, down] of DOMAIN_FLOWS) {
    if (a === up && b === down) return "forward";
    if (a === down && b === up) return "backward";
  }
  return undefined;
}

/** Every pair of cards in a group. */
function linksIn(cards: readonly CanvasCard[]): CanvasLink[] {
  const links: CanvasLink[] = [];
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const a = cards[i];
      const b = cards[j];
      if (a && b) links.push(link(a, b));
    }
  }
  return links;
}

function link(x: CanvasCard, y: CanvasCard): CanvasLink {
  const flow = flowBetween(x.domain?.label, y.domain?.label);
  const [a, b] = flow === "backward" ? [y, x] : [x, y];
  const { shared, level } = compareFiles(a.session.files ?? [], b.session.files ?? []);
  const arrow = flow ? "→" : "↔";
  const branches = `${a.session.repo?.branch ?? "?"} ${arrow} ${b.session.repo?.branch ?? "?"}`;
  const files = `${shared.length} shared file${shared.length === 1 ? "" : "s"}`;
  return {
    key: `${x.key}|${y.key}`,
    source: a.key,
    target: b.key,
    label: `${branches} · ${files}`,
    shared,
    level,
    directed: flow !== undefined,
  };
}

/** Files two sessions both wrote, and whether any of their written lines overlap. */
export function compareFiles(
  a: readonly TouchedFile[],
  b: readonly TouchedFile[],
): { shared: string[]; level: LinkLevel } {
  const other = new Map(b.map((f) => [normalizePath(f.path), f]));
  const shared: string[] = [];
  let lines = false;
  for (const f of a) {
    const g = other.get(normalizePath(f.path));
    if (!g) continue;
    shared.push(f.path);
    if (!lines && rangesOverlap(f.ranges, g.ranges)) lines = true;
  }
  shared.sort();
  return { shared, level: lines ? "lines" : shared.length > 0 ? "file" : "none" };
}

export function rangesOverlap(
  a: readonly (readonly [number, number])[],
  b: readonly (readonly [number, number])[],
): boolean {
  return a.some(([a1, a2]) => b.some(([b1, b2]) => a1 <= b2 && b1 <= a2));
}

/** Windows paths compare case-insensitively with `/` separators. */
function normalizePath(p: string): string {
  const s = p.replace(/\\/g, "/");
  return /^[a-z]:\//i.test(s) ? s.toLowerCase() : s;
}

function lastSegment(p: string): string {
  return (
    p
      .split(/[\\/]+/)
      .filter((s) => s !== "")
      .at(-1) ?? ""
  );
}

function repoRootOf(projectPath: string, relativeCwd: string): string {
  if (!relativeCwd) return projectPath;
  const depth = relativeCwd.split("/").length;
  const parts = projectPath.split(/[\\/]+/);
  return parts.slice(0, Math.max(1, parts.length - depth)).join("/");
}
