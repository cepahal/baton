import { describe, expect, it, vi } from "vitest";
import {
  createNotifier,
  type ExecFileFn,
  MAC_BANNER_TEXT,
  notifyCommands,
  notifyMode,
} from "../src/notify.js";
import { openCommand } from "../src/open-url.js";

const N = {
  title: "Handoff from Ada",
  body: "A session handoff for your Claude Code session.",
  url: "https://baton.example.test/handoffs/habcdefghij",
};

type Call = { file: string; args: readonly string[]; env: NodeJS.ProcessEnv };

/** A fake `execFile`: programs in `installed` succeed, others fail with ENOENT. */
function fakeExec(installed: string[]) {
  const calls: Call[] = [];
  const exec: ExecFileFn = (file, args, options, callback) => {
    calls.push({ file, args, env: options.env });
    if (installed.includes(file)) callback(null);
    else callback(Object.assign(new Error(`spawn ${file} ENOENT`), { code: "ENOENT" }));
    return undefined;
  };
  return { exec: vi.fn(exec), calls };
}

describe("notifications", () => {
  describe("on macOS", () => {
    it("uses terminal-notifier, whose click opens the team server's page", async () => {
      const { exec, calls } = fakeExec(["terminal-notifier", "osascript"]);
      const notify = createNotifier({ platform: "darwin", env: {}, execFile: exec });
      await notify(N);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.file).toBe("terminal-notifier");
      expect(calls[0]?.args).toEqual([
        "-title",
        N.title,
        "-message",
        N.body,
        "-open",
        N.url,
        "-group",
        "baton-handoff",
      ]);
    });

    it("falls back to an osascript banner that says where to look, without a link", async () => {
      const { exec, calls } = fakeExec(["osascript"]);
      const notify = createNotifier({ platform: "darwin", env: {}, execFile: exec });
      await notify(N);
      expect(calls.map((c) => c.file)).toEqual(["terminal-notifier", "osascript"]);
      const args = calls[1]?.args ?? [];
      // The text goes in as arguments, never into the AppleScript source.
      expect(args.slice(0, 6)).toEqual([
        "-e",
        "on run argv",
        "-e",
        "display notification (item 2 of argv) with title (item 1 of argv)",
        "-e",
        "end run",
      ]);
      expect(args[6]).toBe(N.title);
      expect(args[7]).toContain(MAC_BANNER_TEXT);
      expect(args.join(" ")).not.toContain(N.url);

      // Once terminal-notifier is known to be missing, it isn't tried again.
      await notify(N);
      expect(calls.map((c) => c.file)).toEqual(["terminal-notifier", "osascript", "osascript"]);
    });

    it("doesn't put handoff text into the script even when it looks like AppleScript", () => {
      const evil = { ...N, title: '" & (do shell script "id") & "' };
      const [, osa] = notifyCommands(evil, "darwin");
      expect(osa?.args.filter((a) => a.includes("do shell script"))).toEqual([evil.title]);
    });

    it("reports a real failure instead of hiding it", async () => {
      const exec: ExecFileFn = (_file, _args, _options, callback) => {
        callback(Object.assign(new Error("boom"), { code: 1 }));
        return undefined;
      };
      const notify = createNotifier({ platform: "darwin", env: {}, execFile: exec });
      await expect(notify(N)).rejects.toThrow("boom");
    });
  });

  it("on Windows shows a toast whose click opens the URL, passed only through env", async () => {
    const { exec, calls } = fakeExec(["powershell.exe"]);
    await createNotifier({ platform: "win32", env: {}, execFile: exec })(N);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.file).toBe("powershell.exe");
    expect(call?.args.join(" ")).not.toContain(N.url);
    expect(Buffer.from(String(call?.env.BATON_URL), "base64").toString()).toBe(N.url);
    expect(call?.args.join(" ")).toContain("activationType='protocol'");
  });

  it("on Linux puts the URL in the notify-send body", async () => {
    const { exec, calls } = fakeExec(["notify-send"]);
    await createNotifier({ platform: "linux", env: {}, execFile: exec })(N);
    expect(calls[0]?.file).toBe("notify-send");
    expect(calls[0]?.args[0]).toBe(N.title);
    expect(calls[0]?.args[1]).toContain(N.url);
  });

  describe("BATON_NOTIFY", () => {
    it("reads banner, open and off, defaulting to banner", () => {
      expect(notifyMode({})).toBe("banner");
      expect(notifyMode({ BATON_NOTIFY: "OPEN" })).toBe("open");
      expect(notifyMode({ BATON_NOTIFY: "off" })).toBe("off");
      expect(notifyMode({ BATON_NOTIFY: "loud" })).toBe("banner");
    });

    it("open opens the page in the browser instead of notifying", async () => {
      const { exec, calls } = fakeExec(["terminal-notifier"]);
      const open = vi.fn(async () => true);
      const notify = createNotifier({
        platform: "darwin",
        env: { BATON_NOTIFY: "open" },
        execFile: exec,
        open,
      });
      await notify(N);
      expect(open).toHaveBeenCalledWith(N.url);
      expect(calls).toHaveLength(0);
    });

    it("off does nothing at all", async () => {
      const { exec, calls } = fakeExec(["terminal-notifier"]);
      const open = vi.fn(async () => true);
      await createNotifier({
        platform: "darwin",
        env: { BATON_NOTIFY: "off" },
        execFile: exec,
        open,
      })(N);
      expect(calls).toHaveLength(0);
      expect(open).not.toHaveBeenCalled();
    });
  });

  it("opens URLs with each platform's opener", () => {
    expect(openCommand(N.url, "darwin")).toEqual({ file: "open", args: [N.url] });
    expect(openCommand(N.url, "linux")).toEqual({ file: "xdg-open", args: [N.url] });
    const win = openCommand(`${N.url}?a=1&b=2`, "win32");
    expect(win.file).toBe("cmd.exe");
    // `&` would end the `start` command; it has to arrive escaped.
    expect(win.args.at(-1)).toContain("^&");
  });
});
