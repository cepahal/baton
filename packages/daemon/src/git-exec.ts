import { execFile } from "node:child_process";

export type GitResult = { code: number; stdout: string; stderr: string };

/** Runs `git <args>` in `cwd` with extra env, never through a shell. */
export type GitExec = (
  cwd: string,
  args: readonly string[],
  options?: { env?: Record<string, string>; maxBuffer?: number },
) => Promise<GitResult>;

export const gitExec: GitExec = (cwd, args, options = {}) =>
  new Promise((resolve) => {
    execFile(
      "git",
      [...args],
      {
        cwd,
        timeout: 30_000,
        windowsHide: true,
        maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
        env: { ...process.env, ...options.env },
        encoding: "utf8",
      },
      (err, stdout, stderr) => {
        const code =
          err === null ? 0 : typeof err.code === "number" ? err.code : err.killed ? 124 : 1;
        resolve({ code, stdout, stderr });
      },
    );
  });
