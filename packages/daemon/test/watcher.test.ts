import { appendFileSync, utimesSync, writeFileSync } from "node:fs";
import type { BatonEvent } from "@baton/core";
import { afterEach, describe, expect, it } from "vitest";
import { logSources } from "../src/sources.js";
import { StateStore } from "../src/state-store.js";
import { TranscriptWatcher } from "../src/watcher.js";
import { record, SESSION_A, SESSION_B, silent, tempProjects } from "./helpers.js";

async function until(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("TranscriptWatcher startup", () => {
  let cleanup: (() => Promise<void>) | undefined;
  let watcher: TranscriptWatcher | undefined;
  afterEach(async () => {
    await watcher?.close();
    await cleanup?.();
  });

  it("picks up a transcript created after the initial scan but before the watcher is ready", async () => {
    const dirs = await tempProjects();
    cleanup = dirs.cleanup;
    writeFileSync(dirs.transcript(SESSION_A), `${record(SESSION_A, "user", "existing")}\n`);
    const late = dirs.transcript(SESSION_B);
    let created = false;
    const events: BatonEvent[] = [];
    watcher = new TranscriptWatcher({
      sources: logSources({ "claude-code": dirs.projectsDir, codex: dirs.codexDir }),
      sink: { publish: (e) => void events.push(...e) },
      state: await StateStore.load(dirs.stateFile, silent),
      logger: silent,
      backlogPerSession: Number.POSITIVE_INFINITY,
      activeWindowMs: 60_000,
      // `now` is read while opening the files found by the initial scan, so
      // the late file lands after that scan and before chokidar is watching.
      now: () => {
        if (!created) {
          created = true;
          writeFileSync(late, `${record(SESSION_B, "user", "late arrival")}\n`);
        }
        return Date.now();
      },
    });
    await watcher.start();
    await until(() => events.some((e) => e.sessionId === SESSION_B && e.kind === "prompt"));
    expect(events.filter((e) => e.sessionId === SESSION_B && e.kind === "prompt")).toHaveLength(1);
    // And it is watched from then on, not just read once.
    appendFileSync(late, `${record(SESSION_B, "user", "follow-up")}\n`);
    await until(
      () => events.filter((e) => e.sessionId === SESSION_B && e.kind === "prompt").length === 2,
    );
  });

  it("publishes each agent's most recent sessions at startup even when they are old", async () => {
    const dirs = await tempProjects();
    cleanup = dirs.cleanup;
    const day = 24 * 60 * 60;
    const nowS = Date.now() / 1000;
    for (const [session, age] of [
      [SESSION_A, 3 * day],
      [SESSION_B, 2 * day],
    ] as const) {
      const path = dirs.transcript(session);
      writeFileSync(
        path,
        `${record(session, "user", `hello ${session}`)}
`,
      );
      utimesSync(path, nowS - age, nowS - age);
    }
    const events: BatonEvent[] = [];
    watcher = new TranscriptWatcher({
      sources: logSources({ "claude-code": dirs.projectsDir, codex: dirs.codexDir }),
      sink: { publish: (e) => void events.push(...e) },
      state: await StateStore.load(dirs.stateFile, silent),
      logger: silent,
      backlogPerSession: Number.POSITIVE_INFINITY,
      activeWindowMs: 60_000,
      recentPerAgent: 1,
    });
    await watcher.start();
    const sessions = new Set(events.filter((e) => e.kind === "prompt").map((e) => e.sessionId));
    expect([...sessions]).toEqual([SESSION_B]);
  });

  it("reads appends that raise no change event (Codex Desktop on Windows keeps mtime)", async () => {
    const dirs = await tempProjects();
    cleanup = dirs.cleanup;
    const path = dirs.transcript(SESSION_A);
    writeFileSync(
      path,
      `${record(SESSION_A, "user", "first")}
`,
    );
    const events: BatonEvent[] = [];
    watcher = new TranscriptWatcher({
      sources: logSources({ "claude-code": dirs.projectsDir, codex: dirs.codexDir }),
      sink: { publish: (e) => void events.push(...e) },
      state: await StateStore.load(dirs.stateFile, silent),
      logger: silent,
      backlogPerSession: Number.POSITIVE_INFINITY,
      activeWindowMs: 60_000,
      // Polling that never fires stands in for change events that never come.
      poll: true,
      pollIntervalMs: 60 * 60_000,
      sweepIntervalMs: 50,
    });
    await watcher.start();
    // Past the startup read's follow-up checks (RECHECK_MS).
    await new Promise((r) => setTimeout(r, 1000));
    appendFileSync(
      path,
      `${record(SESSION_A, "user", "second")}
`,
    );
    await until(() => events.filter((e) => e.kind === "prompt").length === 2);
  });
});
