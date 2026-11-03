import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import type { AgentId } from "@baton/core";

/** The CLI each agent starts with. No flags are ever added, least of all permission bypasses. */
const AGENT_COMMANDS: Record<AgentId, string> = { "claude-code": "claude", codex: "codex" };

/** Prompts are fixed text plus a handoff path, so this is all they may contain. */
const SAFE_PROMPT = /^[A-Za-z0-9 ./-]+$/;

export type TerminalCommand = {
  file: string;
  args: string[];
  /** Pass the args to Windows as written (cmd's own quoting is used). */
  verbatim?: boolean;
};

export type TerminalRequest = {
  platform: NodeJS.Platform;
  agent: AgentId;
  dir: string;
  prompt: string;
  /** Windows: whether Windows Terminal (`wt.exe`) is installed. */
  hasWindowsTerminal?: boolean;
};

/**
 * The command that opens a new terminal in `dir` running the agent with
 * `prompt`. Pure, so tests can check the exact argv. Returns an error string
 * for input it won't put on a command line.
 */
export function terminalCommand(req: TerminalRequest): TerminalCommand | { error: string } {
  if (!SAFE_PROMPT.test(req.prompt)) return { error: "the prompt has unexpected characters" };
  const agent = AGENT_COMMANDS[req.agent];
  if (/["\r\n\0]/.test(req.dir)) return { error: "the folder name has unexpected characters" };
  switch (req.platform) {
    case "win32":
      // wt splits its command line on `;`, so such folders go through cmd instead.
      if (req.hasWindowsTerminal && !req.dir.includes(";")) {
        return { file: "wt.exe", args: ["-d", req.dir, "cmd.exe", "/k", agent, req.prompt] };
      }
      if (/[%^&|<>]/.test(req.dir))
        return { error: "the folder name has characters cmd can't take" };
      return {
        file: "cmd.exe",
        args: ["/d", "/c", `start "" /D "${req.dir}" cmd.exe /k ${agent} "${req.prompt}"`],
        verbatim: true,
      };
    case "darwin":
      return {
        file: "osascript",
        args: [
          "-e",
          "on run argv",
          "-e",
          'tell application "Terminal" to do script "cd " & quoted form of (item 1 of argv) & " && " & (item 2 of argv) & " " & quoted form of (item 3 of argv)',
          "-e",
          'tell application "Terminal" to activate',
          "-e",
          "end run",
          req.dir,
          agent,
          req.prompt,
        ],
      };
    default:
      return { error: `opening a terminal isn't supported on ${req.platform}` };
  }
}

/** Starts a command detached from the daemon. */
export type Launcher = (command: TerminalCommand, cwd: string) => Promise<void>;

export const launch: Launcher = (command, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, {
      cwd,
      detached: true,
      stdio: "ignore",
      windowsVerbatimArguments: command.verbatim ?? false,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });

/** Whether Windows Terminal is installed for this user. */
export async function hasWindowsTerminal(): Promise<boolean> {
  const local = process.env.LOCALAPPDATA;
  if (!local) return false;
  try {
    await access(join(local, "Microsoft", "WindowsApps", "wt.exe"));
    return true;
  } catch {
    return false;
  }
}
