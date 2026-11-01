import { resolve } from "node:path";

/** Key for a file in maps and the state file. Windows paths compare case-insensitively. */
export function fileKey(path: string, platform: NodeJS.Platform = process.platform): string {
  const abs = resolve(path);
  return platform === "win32" ? abs.toLowerCase() : abs;
}

export const isTranscript = (path: string): boolean => path.toLowerCase().endsWith(".jsonl");
