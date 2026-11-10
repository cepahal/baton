import { execFile } from "node:child_process";

export type ExecFile = (
  file: string,
  args: readonly string[],
  options: { timeout: number; windowsHide: boolean; windowsVerbatimArguments?: boolean },
  callback: (error: Error | null) => void,
) => unknown;

/** Escapes cmd.exe's metacharacters, for `start`'s argument. */
const cmdEscape = (value: string): string => value.replace(/[\^&|<>()%!"]/g, "^$&");

/** The command that opens `url` in the default browser on `platform`. */
export function openCommand(
  url: string,
  platform: NodeJS.Platform,
): { file: string; args: string[]; verbatim?: boolean } {
  if (platform === "darwin") return { file: "open", args: [url] };
  if (platform === "win32") {
    // `start` is a cmd.exe builtin; the empty title keeps it from taking the URL as one.
    return {
      file: "cmd.exe",
      args: ["/d", "/s", "/c", `start "" ${cmdEscape(url)}`],
      verbatim: true,
    };
  }
  return { file: "xdg-open", args: [url] };
}

/** Opens an http(s) URL in the default browser. Never throws: failure just means no browser. */
export function openUrl(
  url: string,
  options: { platform?: NodeJS.Platform; execFile?: ExecFile } = {},
): Promise<boolean> {
  if (!/^https?:\/\//i.test(url)) return Promise.resolve(false);
  const cmd = openCommand(url, options.platform ?? process.platform);
  const run: ExecFile = options.execFile ?? execFile;
  return new Promise((resolve) => {
    try {
      run(
        cmd.file,
        cmd.args,
        {
          timeout: 15_000,
          windowsHide: true,
          ...(cmd.verbatim ? { windowsVerbatimArguments: true } : {}),
        },
        (error) => resolve(error === null),
      );
    } catch {
      resolve(false);
    }
  });
}
