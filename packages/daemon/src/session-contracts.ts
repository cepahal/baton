import {
  type BatonEvent,
  type ContractIssue,
  contractIssues,
  type DomainLabel,
  type Endpoint,
  extractContracts,
  type FileContracts,
  repoRelativePath,
  type Shape,
  writtenTexts,
} from "@baton/core";
import { absolutePath } from "./session-files.js";

/** Per session, files kept beyond this are dropped oldest first. */
export const MAX_CONTRACT_FILES = 300;
/** Per file, entries kept beyond this are dropped oldest first. */
const MAX_PER_FILE = 100;

type Entry = { sessionId: string; domain: DomainLabel | undefined; root: string | null };

/**
 * What each session's writes say about the code's I/O (routes it serves,
 * endpoints it calls, data shapes it declares), and the possible mismatches
 * between sessions of the same repo. Issues are cached until a write changes
 * some session's contracts.
 */
export class SessionContracts {
  readonly #bySession = new Map<string, Map<string, FileContracts>>();
  #version = 0;
  #cache: { key: string; issues: Map<string, ContractIssue[]> } | undefined;

  record(event: BatonEvent): void {
    const texts = writtenTexts(event);
    if (texts.length === 0) return;
    let files = this.#bySession.get(event.sessionId);
    for (const t of texts) {
      const found = extractContracts(t.path, t.text);
      const key = absolutePath(t.path, event.projectPath);
      const prev = files?.get(key);
      const empty = found.routes.length + found.calls.length + found.shapes.length === 0;
      // A whole-file write replaces what the file said; a fragment adds to it.
      if (empty && (!t.whole || !prev)) continue;
      files ??= this.#bySession.get(event.sessionId) ?? new Map();
      this.#bySession.set(event.sessionId, files);
      const next = t.whole || !prev ? found : merge(prev, found);
      files.delete(key);
      if (next.routes.length + next.calls.length + next.shapes.length > 0) files.set(key, next);
      this.#version++;
    }
    while (files && files.size > MAX_CONTRACT_FILES) {
      const oldest = files.keys().next().value;
      if (oldest === undefined) break;
      files.delete(oldest);
    }
  }

  /** Forgets a session (it left the hub's memory). */
  forget(sessionId: string): void {
    if (this.#bySession.delete(sessionId)) this.#version++;
  }

  /**
   * Issues for each of `sessions`, comparing only sessions in the same group
   * (repo). `root` makes file paths comparable across machines.
   */
  issues(sessions: ReadonlyMap<string, Entry & { group: string }>): Map<string, ContractIssue[]> {
    const key = `${this.#version}|${[...sessions]
      .map(([id, e]) => `${id}:${e.group}:${e.domain ?? ""}:${e.root ?? ""}`)
      .join(",")}`;
    if (this.#cache?.key === key) return this.#cache.issues;
    const groups = new Map<
      string,
      { sessionId: string; domain: DomainLabel | undefined; contracts: FileContracts }[]
    >();
    for (const [sessionId, e] of sessions) {
      const files = this.#bySession.get(sessionId);
      if (!files) continue;
      const list = groups.get(e.group) ?? [];
      list.push({ sessionId, domain: e.domain, contracts: flatten(files, e.root) });
      groups.set(e.group, list);
    }
    const issues = new Map<string, ContractIssue[]>();
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      for (const [id, found] of contractIssues(list)) issues.set(id, found);
    }
    this.#cache = { key, issues };
    return issues;
  }
}

function merge(a: FileContracts, b: FileContracts): FileContracts {
  const ep = (list: Endpoint[]) => {
    const m = new Map(list.map((e) => [`${e.method} ${e.path}`, e]));
    return [...m.values()].slice(-MAX_PER_FILE);
  };
  const shapes = new Map<string, Shape>(a.shapes.map((s) => [s.name, s]));
  for (const s of b.shapes) {
    shapes.delete(s.name);
    shapes.set(s.name, s);
  }
  return {
    routes: ep([...a.routes, ...b.routes]),
    calls: ep([...a.calls, ...b.calls]),
    shapes: [...shapes.values()].slice(-MAX_PER_FILE),
  };
}

/** One session's contracts, with file paths relative to `root` when under it. */
function flatten(files: ReadonlyMap<string, FileContracts>, root: string | null): FileContracts {
  const rel = (abs: string) => (root === null ? null : repoRelativePath(root, abs)) || abs;
  const out: FileContracts = { routes: [], calls: [], shapes: [] };
  for (const [abs, c] of files) {
    const file = rel(abs);
    out.routes.push(...c.routes.map((e) => ({ ...e, file })));
    out.calls.push(...c.calls.map((e) => ({ ...e, file })));
    out.shapes.push(...c.shapes.map((s) => ({ ...s, file })));
  }
  return out;
}
