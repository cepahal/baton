import type { DomainLabel } from "../domain/schema.js";
import type { ContractIssue, Endpoint, FileContracts, Shape, ShapeField } from "./schema.js";

/** One session's contracts, file paths relative to the shared repo root. */
export type SessionContractsInput = {
  sessionId: string;
  domain?: DomainLabel | undefined;
  contracts: FileContracts;
};

/** At most this many issues are reported per session. */
export const MAX_ISSUES_PER_SESSION = 5;
const EXAMPLES = 3;

/**
 * Possible I/O mismatches between sessions in the same repo: calls to
 * endpoints the serving session doesn't define (or not for that method), and
 * same-named data shapes whose fields disagree. Heuristic by design: each
 * issue is a hint worth a look, not a proof. Pure and deterministic.
 */
export function contractIssues(
  sessions: readonly SessionContractsInput[],
): Map<string, ContractIssue[]> {
  const sorted = [...sessions].sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  const out = new Map<string, ContractIssue[]>();
  const add = (sessionId: string, issue: ContractIssue) => {
    const list = out.get(sessionId) ?? [];
    if (list.length >= MAX_ISSUES_PER_SESSION) return;
    if (list.some((i) => i.message === issue.message)) return;
    list.push(issue);
    out.set(sessionId, list);
  };
  routeIssues(sorted, add);
  shapeIssues(sorted, add);
  return out;
}

type Add = (sessionId: string, issue: ContractIssue) => void;

// ---------------------------------------------------------------- endpoints

function routeIssues(sessions: readonly SessionContractsInput[], add: Add) {
  const allRoutes = sessions.flatMap((s) => s.contracts.routes);
  for (const caller of sessions) {
    for (const call of uniqueEndpoints(caller.contracts.calls)) {
      if (
        allRoutes.some((r) => pathsMatch(r.path, call.path) && methodsMatch(r.method, call.method))
      ) {
        continue;
      }
      for (const server of sessions) {
        if (server === caller) continue;
        const routes = server.contracts.routes;
        const samePath = routes.filter((r) => sameRoutePath(r.path, call.path));
        const nearby = routes.filter((r) => sameNamespace(r.path, call.path));
        if (samePath.length === 0 && nearby.length === 0) continue;
        const what = `${call.method} ${call.path}`;
        const them = who(server.domain);
        const us = who(caller.domain);
        if (samePath.length > 0) {
          const methods = [...new Set(samePath.map((r) => r.method))].sort().join(", ");
          add(caller.sessionId, {
            kind: "route",
            message: clip(
              `Calls ${what}, but the ${them} session serves that path only as ${methods}.`,
            ),
            otherSessionId: server.sessionId,
          });
          add(server.sessionId, {
            kind: "route",
            message: clip(
              `The ${us} session calls ${what}; this session serves that path only as ${methods}.`,
            ),
            otherSessionId: caller.sessionId,
          });
        } else {
          const ns = namespace(call.path);
          add(caller.sessionId, {
            kind: "route",
            message: clip(
              `Calls ${what}, which the ${them} session doesn't define (it has other ${ns} routes).`,
            ),
            otherSessionId: server.sessionId,
          });
          add(server.sessionId, {
            kind: "route",
            message: clip(`The ${us} session calls ${what}, which isn't defined here.`),
            otherSessionId: caller.sessionId,
          });
        }
      }
    }
  }
}

function uniqueEndpoints(list: readonly Endpoint[]): Endpoint[] {
  const seen = new Map<string, Endpoint>();
  for (const e of list) seen.set(`${e.method} ${e.path}`, e);
  return [...seen.values()];
}

const segments = (p: string) => p.split("/").filter((s) => s !== "");

/** Same length, and each segment equal or a `:param` on either side. */
export function pathsMatch(a: string, b: string): boolean {
  const x = segments(a);
  const y = segments(b);
  return (
    x.length === y.length && x.every((s, i) => s === y[i] || s === ":param" || y[i] === ":param")
  );
}

/**
 * Stricter than pathsMatch, for saying "that path exists with another method":
 * a route's `:param` stands in for a called param, not a literal word like
 * `checkout`, which is more likely a different route.
 */
function sameRoutePath(route: string, call: string): boolean {
  const x = segments(route);
  const y = segments(call);
  return x.length === y.length && x.every((s, i) => s === y[i] || y[i] === ":param");
}

const methodsMatch = (a: string, b: string) => a === b || a === "ANY" || b === "ANY";

/** First two segments (`/api/cart`), or the whole path when shorter. */
function namespace(p: string): string {
  return `/${segments(p).slice(0, 2).join("/")}`;
}

function sameNamespace(a: string, b: string): boolean {
  const x = segments(a).slice(0, 2);
  const y = segments(b).slice(0, 2);
  if (x.length < 2 || y.length < 2) return false;
  return pathsMatch(`/${x.join("/")}`, `/${y.join("/")}`) && !x.includes(":param");
}

function who(domain: DomainLabel | undefined): string {
  return domain && domain !== "unknown" ? domain : "other";
}

// ------------------------------------------------------------------- shapes

/** Name endings that mark the same entity's wire form. */
const SUFFIX = /(?:response|request|dto|schema|model|payload|out|read|data|type|record|entity)$/;
/** UI-only or framework shapes: never compared. */
const SKIP = /(?:props|state|context|config|options|settings|error|event|params|env|theme|style)$/i;

const exactKey = (name: string) => name.toLowerCase();
function baseKey(name: string): string {
  const n = name.replace(/^I(?=[A-Z])/, "").toLowerCase();
  const stripped = n.replace(SUFFIX, "");
  return stripped.length >= 3 ? stripped : n;
}

function shapeIssues(sessions: readonly SessionContractsInput[], add: Add) {
  const latest = sessions.map((s) => ({ s, shapes: latestShapes(s.contracts.shapes) }));
  for (let i = 0; i < latest.length; i++) {
    for (let j = i + 1; j < latest.length; j++) {
      const a = latest[i];
      const b = latest[j];
      if (!a || !b) continue;
      for (const [x, y] of pairs(a.shapes, b.shapes)) {
        const diff = describeDiff(x, y);
        if (!diff) continue;
        add(a.s.sessionId, {
          kind: "shape",
          message: clip(
            `\`${x.name}\` differs from the ${who(b.s.domain)} session's \`${y.name}\`: ${diff.here}`,
          ),
          otherSessionId: b.s.sessionId,
        });
        add(b.s.sessionId, {
          kind: "shape",
          message: clip(
            `\`${y.name}\` differs from the ${who(a.s.domain)} session's \`${x.name}\`: ${diff.there}`,
          ),
          otherSessionId: a.s.sessionId,
        });
      }
    }
  }
}

/** The last definition of each name per file (later writes replace earlier ones). */
function latestShapes(shapes: readonly Shape[]): Shape[] {
  const byKey = new Map<string, Shape>();
  for (const s of shapes) {
    if (SKIP.test(s.name)) continue;
    const key = `${s.file}#${s.name}`;
    byKey.delete(key);
    byKey.set(key, s);
  }
  return [...byKey.values()];
}

/** Shapes to compare: same name, else same base name when no exact match exists. */
function pairs(as: readonly Shape[], bs: readonly Shape[]): [Shape, Shape][] {
  const out: [Shape, Shape][] = [];
  for (const x of as) {
    const others = bs.filter((y) => y.file !== x.file);
    const exact = others.filter((y) => exactKey(y.name) === exactKey(x.name));
    const matches =
      exact.length > 0 ? exact : others.filter((y) => baseKey(y.name) === baseKey(x.name));
    for (const y of matches) {
      // Prefer an exact match on the other side too.
      const hasExactX = as.some(
        (z) => z !== x && z.file !== y.file && exactKey(z.name) === exactKey(y.name),
      );
      if (exact.length === 0 && hasExactX) continue;
      out.push([x, y]);
    }
  }
  return out;
}

const fieldKey = (name: string) => name.toLowerCase().replace(/_/g, "");

/** Both sides' one-line descriptions of how two shapes differ, or undefined if they agree. */
export function describeDiff(x: Shape, y: Shape): { here: string; there: string } | undefined {
  const ys = new Map(y.fields.map((f) => [fieldKey(f.name), f]));
  const xs = new Map(x.fields.map((f) => [fieldKey(f.name), f]));
  const onlyX = x.fields.filter((f) => !ys.has(fieldKey(f.name)));
  const onlyY = y.fields.filter((f) => !xs.has(fieldKey(f.name)));
  const both = x.fields.flatMap((f) => {
    const g = ys.get(fieldKey(f.name));
    return g ? [[f, g] as [ShapeField, ShapeField]] : [];
  });
  // Barely related shapes that happen to share a name: not worth a warning.
  if (both.length < Math.max(1, Math.floor(Math.min(x.fields.length, y.fields.length) / 3))) {
    return undefined;
  }
  const kinds = both.filter(
    ([f, g]) => f.kind !== "unknown" && g.kind !== "unknown" && f.kind !== g.kind,
  );
  const naming = both.filter(([f, g]) => f.name !== g.name);
  if (onlyX.length === 0 && onlyY.length === 0 && kinds.length === 0 && naming.length === 0) {
    return undefined;
  }
  const side = (
    mine: Shape,
    theirs: Shape,
    onlyMine: ShapeField[],
    onlyTheirs: ShapeField[],
    flip: boolean,
  ) => {
    const parts: string[] = [];
    if (mine.fields.length !== theirs.fields.length) {
      parts.push(`${mine.fields.length} fields here vs ${theirs.fields.length} there`);
    }
    if (onlyTheirs.length > 0) parts.push(`missing here: ${names(onlyTheirs)}`);
    if (onlyMine.length > 0) parts.push(`not there: ${names(onlyMine)}`);
    const [k] = kinds;
    if (k) {
      const [m, t] = flip ? [k[1], k[0]] : k;
      parts.push(`\`${m.name}\` is ${m.kind} here, ${t.kind} there`);
    }
    const [n] = naming;
    if (n) {
      const [m, t] = flip ? [n[1], n[0]] : n;
      parts.push(`\`${m.name}\` vs \`${t.name}\``);
    }
    return parts.join("; ");
  };
  return { here: side(x, y, onlyX, onlyY, false), there: side(y, x, onlyY, onlyX, true) };
}

function names(fields: readonly ShapeField[]): string {
  const shown = fields
    .slice(0, EXAMPLES)
    .map((f) => f.name)
    .join(", ");
  return fields.length > EXAMPLES ? `${shown} +${fields.length - EXAMPLES}` : shown;
}

function clip(s: string): string {
  return s.length <= 240 ? s : `${s.slice(0, 237)}...`;
}
