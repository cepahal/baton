import { execFile } from "node:child_process";

/** Shows an OS notification. Failures are the caller's to log; nothing depends on it. */
export type Notifier = (n: { title: string; body: string; url: string }) => Promise<void>;

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
$xml.LoadXml("<toast activationType='protocol' launch='$url'><visual><binding template='ToastGeneric'><text>$title</text><text>$body</text></binding></visual><actions><action content='Open' activationType='protocol' arguments='$url'/></actions></toast>")
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
`;

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

function run(file: string, args: string[], env?: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: 15_000, windowsHide: true, env: { ...process.env, ...env } },
      (err) => (err ? reject(err) : resolve()),
    );
  });
}

export const osNotify: Notifier = async ({ title, body, url }) => {
  switch (process.platform) {
    case "win32":
      await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_TOAST], {
        BATON_TITLE: b64(title),
        BATON_BODY: b64(body),
        BATON_URL: b64(url),
      });
      return;
    case "darwin":
      // macOS notifications can't open a URL; the viewer banner links to the page.
      await run("osascript", [
        "-e",
        "on run argv",
        "-e",
        "display notification (item 2 of argv) with title (item 1 of argv)",
        "-e",
        "end run",
        title,
        body,
      ]);
      return;
    default:
      await run("notify-send", [title, `${body}\n${url}`]);
  }
};
