import { execFile } from "node:child_process";
import { z } from "zod";
import { openUrl } from "./open-url.js";

/** Shows an OS notification. Failures are the caller's to log; nothing depends on it. */
export type Notifier = (n: { title: string; body: string; url: string }) => Promise<void>;

/**
 * `BATON_NOTIFY`: `banner` (default) shows an OS notification, `open` opens
 * the handoff's page in the default browser instead, `off` does nothing.
 */
export const NotifyMode = z.enum(["banner", "open", "off"]);
export type NotifyMode = z.infer<typeof NotifyMode>;

/** The mode from the environment; anything unrecognised means the default. */
export function notifyMode(env: NodeJS.ProcessEnv = process.env): NotifyMode {
  const parsed = NotifyMode.safeParse(env.BATON_NOTIFY?.trim().toLowerCase());
  return parsed.success ? parsed.data : "banner";
}

// A fixed script: the text and URL arrive base64-encoded in env vars and are
// XML-escaped here, so nothing from a handoff is ever parsed as PowerShell.
const WINDOWS_TOAST = `
$ErrorActionPreference = 'Stop'
function D($v) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($v)) }
function X($v) { [Security.SecurityElement]::Escape($v) }
$title = X (D $env:BATON_TITLE); $body = X (D $env:BATON_BODY); $url = X (D $env:BATON_URL)
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml("<toast activationType='protocol' launch='$url'><visual><binding template='ToastGeneric'><text>$title</text><text>$body</text></binding></visual><actions><action content='Review' activationType='protocol' arguments='$url'/></actions></toast>")
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
`;

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

/** One program to run. */
export type NotifyCommand = { file: string; args: string[]; env?: Record<string, string> };

/** What macOS shows when the notification can't open a link: clicking it does nothing useful. */
export const MAC_BANNER_TEXT = "Open Baton to review";

/**
 * The commands that show a notification on `platform`, best first: on macOS
 * `terminal-notifier` (its click opens the URL) and then `osascript`, whose
 * banner can't carry a link and so only says where to look.
 */
export function notifyCommands(
  n: { title: string; body: string; url: string },
  platform: NodeJS.Platform,
): NotifyCommand[] {
  switch (platform) {
    case "win32":
      return [
        {
          file: "powershell.exe",
          args: ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_TOAST],
          env: { BATON_TITLE: b64(n.title), BATON_BODY: b64(n.body), BATON_URL: b64(n.url) },
        },
      ];
    case "darwin":
      return [
        {
          file: "terminal-notifier",
          args: ["-title", n.title, "-message", n.body, "-open", n.url, "-group", "baton-handoff"],
        },
        {
          file: "osascript",
          args: [
            "-e",
            "on run argv",
            "-e",
            "display notification (item 2 of argv) with title (item 1 of argv)",
            "-e",
            "end run",
            n.title,
            `${n.body} ${MAC_BANNER_TEXT}.`,
          ],
        },
      ];
    default:
      return [{ file: "notify-send", args: [n.title, `${n.body}\nReview it: ${n.url}`] }];
  }
}

export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: { timeout: number; windowsHide: boolean; env: NodeJS.ProcessEnv },
  callback: (error: (Error & { code?: unknown }) | null) => void,
) => unknown;

/** Whether an exec error means the program isn't installed. */
const notInstalled = (err: Error & { code?: unknown }) => err.code === "ENOENT";

export function createNotifier(
  options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    execFile?: ExecFileFn;
    open?: (url: string) => Promise<boolean>;
  } = {},
): Notifier {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exec: ExecFileFn = options.execFile ?? execFile;
  const open = options.open ?? ((url: string) => openUrl(url, { platform }));
  const run = (cmd: NotifyCommand) =>
    new Promise<void>((resolve, reject) => {
      exec(
        cmd.file,
        cmd.args,
        { timeout: 15_000, windowsHide: true, env: { ...env, ...cmd.env } },
        (err) => (err ? reject(err) : resolve()),
      );
    });
  /** Programs found missing, so later notifications skip them. */
  const missing = new Set<string>();

  return async (n) => {
    const mode = notifyMode(env);
    if (mode === "off") return;
    if (mode === "open") {
      if (!(await open(n.url))) throw new Error(`could not open ${n.url}`);
      return;
    }
    const commands = notifyCommands(n, platform).filter((c) => !missing.has(c.file));
    let lastError: unknown;
    for (const cmd of commands) {
      try {
        await run(cmd);
        return;
      } catch (err) {
        lastError = err;
        if (err instanceof Error && notInstalled(err)) {
          missing.add(cmd.file);
          continue;
        }
        throw err;
      }
    }
    if (lastError !== undefined) throw lastError;
  };
}

export const osNotify: Notifier = createNotifier();
