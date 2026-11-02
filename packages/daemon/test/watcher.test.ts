import { appendFileSync, writeFileSync } from "node:fs";
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
});
