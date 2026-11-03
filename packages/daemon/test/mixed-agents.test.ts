import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type BatonEvent, parseSession, SessionsResponse } from "@baton/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Daemon } from "../src/daemon.js";
import { type ReplayPlan, runReplay } from "../src/replay.js";
import { silent, start, TestClient, tempProjects, wsUrl } from "./helpers.js";

const FIXTURES = join(import.meta.dirname, "../../core/test/fixtures");

/** Two Claude Code sessions and two Codex threads, written at the same time. */
const REPLAYS = [
  { fixture: "heavy-tools.jsonl", as: "alice" },
  { fixture: "codex/speech-tool.rollout.jsonl", as: "bob" },
  { fixture: "mixed.jsonl", as: "carol" },
  { fixture: "codex/forked-frontend.rollout.jsonl", as: "dave" },
];

let dirs: Awaited<ReturnType<typeof tempProjects>>;
let daemon: Daemon | undefined;
let client: TestClient | undefined;

beforeEach(async () => {
  dirs = await tempProjects();
  // Today's rollout folder, where the replays write (UTC, like rolloutPath).
  // Made up front so the watcher sees it from the start: a folder appearing
  // mid-test is noticed late on a loaded machine, and the Codex replays then
  // arrive only after the Claude ones, which defeats the overlap check.
  const [y = "", m = "", d = ""] = new Date().toISOString().slice(0, 10).split("-");
  await mkdir(join(dirs.codexDir, y, m, d), { recursive: true });
});

afterEach(async () => {
  await client?.close();
  client = undefined;
  await daemon?.close();
  daemon = undefined;
  await dirs.cleanup();
});

describe("Claude Code and Codex sessions at once", () => {
  it("streams every event of both agents' live sessions exactly once, in order", async () => {
    daemon = await start(dirs);
    client = new TestClient(wsUrl(daemon));
    await client.opened;

    const plans: ReplayPlan[] = await Promise.all(
      REPLAYS.map((r) =>
        runReplay({
          fixture: join(FIXTURES, r.fixture),
          projectsDir: dirs.projectsDir,
          codexDir: dirs.codexDir,
          // Slow enough that each replay lasts a few seconds (a fast one is over
          // before a busy watcher notices the other agent's file), with pauses
          // capped so the test stays short.
          speed: 100,
          maxGapMs: 40,
          as: r.as,
          seed: r.as,
          logger: silent,
        }),
      ),
    );
    expect(plans.map((p) => p.agent)).toEqual(["claude-code", "codex", "claude-code", "codex"]);

    // What the parser makes of each written file is what the viewer must get.
    const expected = new Map<string, BatonEvent[]>();
    for (const plan of plans) {
      const { events } = parseSession(plan.agent, await readFile(plan.file, "utf8"));
      expect(events.length).toBeGreaterThan(10);
      expected.set(plan.sessionId, events);
    }
    const total = [...expected.values()].reduce((n, e) => n + e.length, 0);
    const c = client;
    await c.until(() => c.events.length >= total, `${total} events`, 30_000);
    // Nothing more trickles in late (duplicates would).
    await new Promise((r) => setTimeout(r, 500));

    const received = c.events;
    expect(received).toHaveLength(total);
    const hubSeqs = received.map((m) => m.seq);
    expect(hubSeqs).toEqual([...hubSeqs].sort((a, b) => a - b));
    // Ids are unique per session; the forked Codex fixture shares item ids with the other.
    expect(new Set(received.map((m) => `${m.event.sessionId} ${m.event.id}`)).size).toBe(total);

    for (const plan of plans) {
      const got = received.map((m) => m.event).filter((e) => e.sessionId === plan.sessionId);
      const want = expected.get(plan.sessionId) ?? [];
      expect(got.map((e) => [e.seq, e.id, e.kind, e.agent])).toEqual(
        want.map((e) => [e.seq, e.id, e.kind, e.agent]),
      );
    }
    // The two agents' sessions really did overlap in time.
    const firstLast = plans.map((p) => {
      const idx = received.flatMap((m, i) => (m.event.sessionId === p.sessionId ? [i] : []));
      return [idx[0] ?? -1, idx.at(-1) ?? -1] as const;
    });
    const [claudeA, codexA] = firstLast;
    if (!claudeA || !codexA) throw new Error("missing replay");
    expect(codexA[0]).toBeLessThan(claudeA[1]);
    expect(claudeA[0]).toBeLessThan(codexA[1]);

    const res = await fetch(`${daemon.url}/sessions`);
    const { sessions } = SessionsResponse.parse(await res.json());
    expect(
      sessions
        .map((s) => [s.sessionId, s.agent])
        .sort(([a], [b]) => String(a).localeCompare(String(b))),
    ).toEqual(
      plans
        .map((p) => [p.sessionId, p.agent])
        .sort(([a], [b]) => String(a).localeCompare(String(b))),
    );
  }, 60_000);
});
