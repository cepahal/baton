import { resolve } from "node:path";

/** Key for a file in maps and the state file. Windows paths compare case-insensitively. */
export function fileKey(path: string, platform: NodeJS.Platform = process.platform): string {
  const abs = resolve(path);
  return platform === "win32" ? abs.toLowerCase() : abs;
}

export const isTranscript = (path: string): boolean => path.toLowerCase().endsWith(".jsonl");

/**
 * A session directory as the OS can use it. Claude Code on Windows sometimes
 * records Git Bash paths (`/c/Users/...`); Node and git need `C:\Users\...`.
 */
export function osDir(dir: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return dir;
  const m = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(dir);
  if (!m) return dir;
  const drive = (m[1] ?? "").toUpperCase();
  const rest = (m[2] ?? "").replace(/\//g, "\\");
  return `${drive}:\\${rest}`;
}
