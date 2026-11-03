import {
  type BatonEvent,
  fileTouches,
  type LineRange,
  mergeRanges,
  repoRelativePath,
  type TouchedFile,
} from "@baton/core";

/** Per session, files kept beyond this are dropped oldest first. */
export const MAX_FILES_PER_SESSION = 500;
/** Per file, ranges beyond this collapse into one span. */
const MAX_RANGES_PER_FILE = 64;

/** Files each session wrote, by absolute path, with the lines when known. */
export class SessionFiles {
  readonly #bySession = new Map<string, Map<string, LineRange[]>>();

  record(event: BatonEvent): void {
    const touches = fileTouches(event);
    if (touches.length === 0) return;
    let files = this.#bySession.get(event.sessionId);
    if (!files) {
      files = new Map();
      this.#bySession.set(event.sessionId, files);
    }
    for (const t of touches) {
      const key = absolutePath(t.path, event.projectPath);
      const prev = files.get(key) ?? [];
      files.delete(key); // re-insert: most recently touched last
      let ranges = mergeRanges([...prev, ...t.ranges]);
      if (ranges.length > MAX_RANGES_PER_FILE) {
        const first = ranges[0];
        const last = ranges.at(-1);
        ranges = first && last ? [[first[0], last[1]]] : [];
      }
      files.set(key, ranges);
    }
    while (files.size > MAX_FILES_PER_SESSION) {
      const oldest = files.keys().next().value;
      if (oldest === undefined) break;
      files.delete(oldest);
    }
  }

  /** Forgets a session (it left the hub's memory). */
  forget(sessionId: string): void {
    this.#bySession.delete(sessionId);
  }

  /** The session's files, relative to `root` when they sit under it. */
  files(sessionId: string, root: string | null): TouchedFile[] {
    const files = this.#bySession.get(sessionId);
    if (!files) return [];
    return [...files].map(([path, ranges]) => ({
      path: (root === null ? null : repoRelativePath(root, path)) || path,
      ranges: ranges.map(([a, b]) => [a, b] as [number, number]),
    }));
  }
}

/** `path` made absolute against `cwd` (POSIX, Windows or UNC), with `/` separators. */
export function absolutePath(path: string, cwd: string): string {
  const isAbs = /^([a-z]:[\\/]|[\\/])/i.test(path);
  const joined = (isAbs || cwd === "" ? path : `${cwd.replace(/[\\/]+$/, "")}/${path}`).replace(
    /\\/g,
    "/",
  );
  // UNC (`//server/share/...`) keeps its leading double slash.
  const unc = /^\/\/[^/]/.test(joined);
  const parts: string[] = [];
  for (const seg of (unc ? joined.slice(2) : joined).split("/")) {
    if (seg === "." || (seg === "" && parts.length > 0)) continue;
    if (seg === ".." && parts.length > 1) parts.pop();
    else parts.push(seg);
  }
  return `${unc ? "//" : ""}${parts.join("/")}`;
}
