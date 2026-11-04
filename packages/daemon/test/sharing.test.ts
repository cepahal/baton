import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BatonEvent, RepoInfo } from "@baton/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiskQueue } from "../src/disk-queue.js";
import { startForwarder } from "../src/forwarder.js";
import { osDir } from "../src/paths.js";
import {
  EMPTY_SHARING,
  isInside,
  isShared,
  SharingPolicy,
  SharingSink,
  writeSharing,
} from "../src/sharing.js";
import type { EventSink, PublishOptions } from "../src/sink.js";
import { record, SESSION_A, silent, tempProjects } from "./helpers.js";

const REPO: RepoInfo = { repoId: "github.com/acme/app", branch: "main", relativeCwd: "" };
const NOT_GIT: RepoInfo = { repoId: null, branch: null, relativeCwd: null };

let n = 0;
const event = (projectPath: string, text = "hi"): BatonEvent => ({
  id: `e${++n}`,
  agent: "claude-code",
  sessionId: `s-${projectPath}`,
  projectPath,
  ts: "2026-11-03T10:00:00.000Z",
  seq: n,
  kind: "prompt",
  text,
});

class Collect implements EventSink {
  readonly got: { events: BatonEvent[]; options: PublishOptions }[] = [];
  publish(events: readonly BatonEvent[], options: PublishOptions = {}) {
    this.got.push({ events: [...events], options });
  }
  get events() {
    return this.got.flatMap((g) => g.events);
  }
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "baton-sharing-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("isInside / isShared", () => {
  it("matches a folder and what's under it, nothing beside it", () => {
    expect(isInside("/work/app", "/work/app", "linux")).toBe(true);
    expect(isInside("/work/app", "/work/app/src", "linux")).toBe(true);
    expect(isInside("/work/app", "/work/app-secret", "linux")).toBe(false);
    expect(isInside("/work/app", "/work", "linux")).toBe(false);
    expect(isInside("/Work/App", "/work/app/x", "darwin")).toBe(true);
    expect(isInside("/Work/App", "/work/app/x", "linux")).toBe(false);
  });

  it("turns Git Bash paths into Windows ones, on Windows only", () => {
    expect(osDir("/c/Users/dev/app", "win32")).toBe("C:\\Users\\dev\\app");
    expect(osDir("/d", "win32")).toBe("D:\\");
    expect(osDir("C:\\Users\\dev", "win32")).toBe("C:\\Users\\dev");
    expect(osDir("/c/Users/dev/app", "darwin")).toBe("/c/Users/dev/app");
    expect(osDir("/home/dev", "win32")).toBe("/home/dev");
  });

  it("shares nothing by default, and nothing while paused", () => {
    expect(isShared(EMPTY_SHARING, "/work/app", REPO)).toBe(false);
    const allowed = { paused: false, repos: ["github.com/acme/app"], folders: [] };
    expect(isShared(allowed, "/work/app", REPO)).toBe(true);
    expect(isShared({ ...allowed, paused: true }, "/work/app", REPO)).toBe(false);
    expect(isShared(allowed, "/elsewhere", NOT_GIT)).toBe(false);
  });
});

describe("SharingSink", () => {
  const policy = (repoOf: (dir: string) => RepoInfo, file = join(dir, "sharing.json")) =>
    new SharingPolicy({ file, repoOf: async (d) => repoOf(d), logger: silent, recheckMs: 0 });

  it("drops everything when no sharing file exists", async () => {
    const inner = new Collect();
    const sink = new SharingSink(
      inner,
      policy(() => REPO),
      silent,
    );
    await sink.publish([event("/work/app")]);
    expect(inner.events).toEqual([]);
  });

  it("passes only shared repos and folders, with secrets masked and no repo info for others", async () => {
    const file = join(dir, "sharing.json");
    await writeSharing(file, {
      paused: false,
      repos: ["github.com/acme/app"],
      folders: ["/notes"],
    });
    const inner = new Collect();
    const sink = new SharingSink(
      inner,
      policy((d) => (d.startsWith("/work/app") ? REPO : NOT_GIT), file),
      silent,
    );
    const key = `gh${"p_"}${"z".repeat(36)}`;
    await sink.publish(
      [event("/work/app", `key ${key}`), event("/private"), event("/notes/today")],
      { repos: { "/private": { repoId: "github.com/me/secret", branch: null, relativeCwd: "" } } },
    );
    expect(inner.events.map((e) => [e.projectPath, e.text])).toEqual([
      ["/work/app", "key [redacted]"],
      ["/notes/today", "hi"],
    ]);
    expect(inner.got[0]?.options.repos).toBeUndefined();
  });

  it("shares the rest of a session once it's seen in a shared repo, until settings change", async () => {
    // A real Windows transcript spells one folder three ways; only one resolves in git.
    const file = join(dir, "sharing.json");
    await writeSharing(file, { paused: false, repos: ["github.com/acme/app"], folders: [] });
    const inner = new Collect();
    const sink = new SharingSink(
      inner,
      policy((d) => (d === "/work/app" ? REPO : NOT_GIT), file),
      silent,
    );
    const session = (projectPath: string) => ({ ...event(projectPath), sessionId: "one" });
    await sink.publish([session("/work/app"), session("C:\\Users\\dev\\app")]);
    await sink.publish([session("/work/app/sub")]);
    expect(inner.events.map((e) => e.projectPath)).toEqual([
      "/work/app",
      "C:\\Users\\dev\\app",
      "/work/app/sub",
    ]);
    // Another session in an unshared folder still isn't sent.
    await sink.publish([event("/private")]);
    expect(inner.events).toHaveLength(3);

    // Unsharing forgets it at once.
    await writeSharing(file, { paused: false, repos: [], folders: [] });
    await utimes(file, new Date(), new Date(Date.now() + 5000));
    await sink.publish([session("C:\\Users\\dev\\app")]);
    expect(inner.events).toHaveLength(3);
  });

  it("picks up `baton pause` without a restart", async () => {
    const file = join(dir, "sharing.json");
    await writeSharing(file, { paused: false, repos: [], folders: ["/work"] });
    const inner = new Collect();
    const sink = new SharingSink(
      inner,
      policy(() => NOT_GIT, file),
      silent,
    );
    await sink.publish([event("/work/a")]);
    await writeSharing(file, { paused: true, repos: [], folders: ["/work"] });
    // Some filesystems keep mtimes to the second; make the change visible.
    await utimes(file, new Date(), new Date(Date.now() + 5000));
    await sink.publish([event("/work/b")]);
    expect(inner.events.map((e) => e.projectPath)).toEqual(["/work/a"]);
  });
});

describe("forwarder upgrade", () => {
  it("drops events an older Baton queued before sharing controls existed", async () => {
    const dirs = await tempProjects();
    try {
      const queueDir = join(dirs.root, "queue");
      const old = await DiskQueue.open({ dir: queueDir, maxBytes: 1 << 20, logger: silent });
      await old.push([{ backlog: false, event: event("/home/dev/private", "queued long ago") }]);
      await old.close();
      // `baton share` ran after the upgrade but before the daemon restarted.
      await writeSharing(join(dirs.root, "sharing.json"), {
        paused: false,
        repos: [],
        folders: [join(dirs.root, "elsewhere")],
      });
      await dirs.append(dirs.transcript(SESSION_A), `${record(SESSION_A, "user", "hi")}\n`);

      const forwarder = await startForwarder(
        {
          port: 0,
          projectsDir: dirs.projectsDir,
          codexDir: dirs.codexDir,
          stateFile: dirs.stateFile,
          backlog: "all",
          bufferMb: 1,
          activeMinutes: 120,
          recent: 0,
          poll: false,
          logLevel: "silent",
          summarizer: "off",
          ollamaUrl: "http://127.0.0.1:11434",
          webDir: dirs.root,
        },
        // Nothing listens here, so anything shared would sit in the queue.
        { server: "ws://127.0.0.1:9", token: "t", name: "x", queueDir, queueMb: 1 },
        silent,
      );
      await new Promise((r) => setTimeout(r, 300));
      expect(forwarder.sink.pending).toBe(0);
      await forwarder.close();
    } finally {
      await dirs.cleanup();
    }
  });
});
