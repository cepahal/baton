import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type BatonEvent,
  type DomainClassification,
  type RepoInfo,
  SessionsResponse,
} from "@baton/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryEventLog } from "../src/event-log.js";
import { Hub } from "../src/hub.js";
import { LlmTieBreaker, parseLabel, tieBreakPrompt } from "../src/llm-tie-breaker.js";
import { type GitRunner, lookupRepo, RepoResolver } from "../src/repo-info.js";
import { RepoTaggingSink } from "../src/repo-sink.js";
import { createServer } from "../src/server.js";
import { repoRoot } from "../src/session-domains.js";
import type { PublishOptions } from "../src/sink.js";
import { SESSION_A, SESSION_B, silent } from "./helpers.js";

const PROJECT = "/home/dev/proj/apps/web";
let n = 0;
const base = (sessionId: string) => ({
  id: `d${++n}`,
  agent: "claude-code" as const,
  sessionId,
  projectPath: PROJECT,
  ts: "2026-11-01T12:00:00.000Z",
  seq: n,
});
const prompt = (sessionId: string, text: string): BatonEvent => ({
  ...base(sessionId),
  kind: "prompt",
  text,
});
const edit = (sessionId: string, file: string): BatonEvent => ({
  ...base(sessionId),
  kind: "tool_call",
  text: file,
  meta: { toolName: "Edit", toolUseId: `t${n}`, input: { file_path: `/home/dev/proj/${file}` } },
});

const hub = (options: Partial<ConstructorParameters<typeof Hub>[0]> = {}) =>
  new Hub({
    log: new MemoryEventLog({ maxBytes: 1024 * 1024, maxEvents: 1000 }),
    activeWindowMs: 60 * 60_000,
    logger: silent,
    now: () => Date.parse("2026-11-01T12:01:00.000Z"),
    ...options,
  });

const REPO: RepoInfo = { repoId: "github.com/org/proj", branch: "main", relativeCwd: "apps/web" };

describe("Hub domains", () => {
  it("classifies each session and carries its repo identity", () => {
    const h = hub();
    h.publish([prompt(SESSION_A, "fix the sidebar css")], { repos: { [PROJECT]: REPO } });
    h.publish([edit(SESSION_A, "apps/web/src/App.tsx"), edit(SESSION_A, "apps/web/src/Nav.tsx")]);
    h.publish([edit(SESSION_B, "infra/main.tf")]);
    const [a, b] = [SESSION_A, SESSION_B].map((id) => h.sessions().find((s) => s.sessionId === id));
    expect(a?.repo).toEqual(REPO);
    expect(a?.domain).toMatchObject({ label: "frontend", source: "rules" });
    // Edited paths are shown relative to the repo root, not the session cwd.
    expect(a?.domain?.reasons).toContain("edited apps/web/src/App.tsx (web/)");
    expect(b?.repo).toEqual(REPO); // same directory, same repo
    expect(b?.domain).toMatchObject({ label: "infra" });
  });

  it("lets a manual override win, and clears it", () => {
    const h = hub();
    h.publish([edit(SESSION_A, "infra/main.tf")]);
    expect(h.setDomainOverride(SESSION_A, "ml")).toBe(true);
    expect(h.sessions()[0]?.domain).toEqual({
      label: "ml",
      confidence: 1,
      reasons: ["set by hand"],
      source: "override",
    });
    h.publish([edit(SESSION_A, "infra/other.tf")]);
    expect(h.sessions()[0]?.domain?.label).toBe("ml");
    h.setDomainOverride(SESSION_A, null);
    expect(h.sessions()[0]?.domain).toMatchObject({ label: "infra", source: "rules" });
    expect(h.setDomainOverride(SESSION_B, "ml")).toBe(false);
  });

  it("asks the tie-breaker only when the rules are unsure", () => {
    const asked: DomainClassification[] = [];
    const h = hub({
      tieBreaker: {
        advise: (_id, rules) => {
          asked.push(rules);
          return "data";
        },
      },
    });
    h.publish([prompt(SESSION_A, "fix the css")]); // thin evidence
    expect(h.sessions()[0]?.domain).toMatchObject({
      label: "data",
      confidence: 0.5,
      source: "llm",
    });
    expect(asked[0]).toMatchObject({ label: "frontend" });
    h.publish([edit(SESSION_A, "web/a.tsx"), edit(SESSION_A, "web/b.tsx")]);
    asked.length = 0;
    expect(h.sessions()[0]?.domain).toMatchObject({ label: "frontend", source: "rules" });
    expect(asked).toEqual([]);
  });
});

describe("LlmTieBreaker", () => {
  const rules: DomainClassification = {
    label: "unknown",
    confidence: 0,
    reasons: ["no domain signals"],
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("caches per session and re-asks at most every five minutes", async () => {
    let now = 0;
    let calls = 0;
    const tb = new LlmTieBreaker({
      ask: async () => {
        calls++;
        return calls === 1 ? "backend" : "Infra.";
      },
      logger: silent,
      now: () => now,
    });
    const events = [prompt(SESSION_A, "hmm")];
    expect(tb.advise(SESSION_A, rules, events)).toBeUndefined(); // first ask is in flight
    expect(tb.advise(SESSION_A, rules, events)).toBeUndefined();
    await flush();
    expect(calls).toBe(1);
    now += 4 * 60_000;
    expect(tb.advise(SESSION_A, rules, events)).toBe("backend");
    expect(calls).toBe(1);
    now += 60_000;
    expect(tb.advise(SESSION_A, rules, events)).toBe("backend"); // stale answer while refreshing
    await flush();
    expect(calls).toBe(2);
    expect(tb.advise(SESSION_A, rules, events)).toBe("infra");
    expect(tb.advise(SESSION_B, rules, events)).toBeUndefined();
    await flush();
    expect(calls).toBe(3);
  });

  it("survives a failing model", async () => {
    const tb = new LlmTieBreaker({
      ask: () => Promise.reject(new Error("offline")),
      logger: silent,
    });
    expect(tb.advise(SESSION_A, rules, [])).toBeUndefined();
    await flush();
    expect(tb.advise(SESSION_A, rules, [])).toBeUndefined();
  });

  it("parses one label out of a reply", () => {
    expect(parseLabel("ML")).toBe("ml");
    expect(parseLabel("I think this is **frontend** work")).toBe("frontend");
    expect(parseLabel("no idea")).toBeUndefined();
  });

  it("builds a short prompt from edits and prompts", () => {
    const text = tieBreakPrompt(rules, [
      prompt(SESSION_A, "tune the   query"),
      edit(SESSION_A, "db/x.sql"),
    ]);
    expect(text).toContain("frontend, backend, ml, data, infra, unknown");
    expect(text).toContain("Files edited: /home/dev/proj/db/x.sql");
    expect(text).toContain("- tune the query");
  });
});

describe("PUT /sessions/:id/domain", () => {
  it("overrides, validates and 404s", async () => {
    const h = hub();
    h.publish([edit(SESSION_A, "infra/main.tf")]);
    const app = await createServer(h, silent, { access: { kind: "local" } });
    const put = (id: string, body: unknown) =>
      app.inject({ method: "PUT", url: `/sessions/${id}/domain`, payload: body as object });
    expect((await put(SESSION_A, { label: "data" })).json()).toMatchObject({
      label: "data",
      source: "override",
    });
    const list = SessionsResponse.parse((await app.inject({ url: "/sessions" })).json());
    expect(list.sessions[0]?.domain?.label).toBe("data");
    expect((await put(SESSION_A, { label: null })).json()).toMatchObject({
      label: "infra",
      source: "rules",
    });
    expect((await put(SESSION_A, { label: "gaming" })).statusCode).toBe(400);
    expect((await put(SESSION_B, { label: "ml" })).statusCode).toBe(404);
    await app.close();
  });
});

describe("repoRoot", () => {
  it("strips the repo-relative tail from the session cwd", () => {
    expect(repoRoot("/home/dev/proj/apps/web", "apps/web")).toBe("/home/dev/proj");
    expect(repoRoot("C:\\src\\proj\\Apps\\Web", "apps/web")).toBe("C:\\src\\proj");
    expect(repoRoot("/home/dev/proj", "")).toBe("/home/dev/proj");
    expect(repoRoot("/elsewhere", "apps/web")).toBe("/elsewhere");
  });
});

describe("lookupRepo", () => {
  const fakeGit =
    (answers: Record<string, string | undefined>, calls: string[] = []): GitRunner =>
    async (_cwd, args) => {
      calls.push(args.join(" "));
      return answers[args.join(" ")];
    };

  it("prefers origin's normalized URL", async () => {
    const git = fakeGit({
      "rev-parse --show-toplevel": "C:/src/proj\n",
      "symbolic-ref --quiet --short HEAD": "feature/x\n",
      remote: "upstream\norigin\n",
      "remote get-url origin": "git@github.com:Org/Proj.git\n",
    });
    expect(await lookupRepo("C:\\src\\proj\\packages\\core", git)).toEqual({
      repoId: "github.com/org/proj",
      branch: "feature/x",
      relativeCwd: "packages/core",
    });
  });

  it("falls back to the root commit, and to null outside git", async () => {
    const git = fakeGit({
      "rev-parse --show-toplevel": "/repo\n",
      remote: "",
      "rev-list --max-parents=0 HEAD": "bbbbbbb1\naaaaaaa2\n",
    });
    expect(await lookupRepo("/repo", git)).toEqual({
      repoId: "aaaaaaa2",
      branch: null,
      relativeCwd: "",
    });
    expect(await lookupRepo("/tmp", fakeGit({}))).toEqual({
      repoId: null,
      branch: null,
      relativeCwd: null,
    });
  });

  it("caches per directory", async () => {
    const calls: string[] = [];
    const resolver = new RepoResolver({ git: fakeGit({}, calls) });
    await Promise.all([resolver.resolve("/x"), resolver.resolve("/x")]);
    await resolver.resolve("/x");
    expect(calls.filter((c) => c === "rev-parse --show-toplevel")).toHaveLength(1);
  });

  describe("against a real repository", () => {
    const run = promisify(execFile);
    let root = "";
    beforeAll(async () => {
      root = await realpath(await mkdtemp(join(tmpdir(), "baton-repo-")));
      const git = (...args: string[]) => run("git", args, { cwd: root });
      await git("init", "-q", "-b", "trunk");
      await git(
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.invalid",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "root",
      );
      await mkdir(join(root, "apps", "web"), { recursive: true });
    });
    afterAll(() => rm(root, { recursive: true, force: true }));

    it("reads branch, root commit and relative cwd, then the remote once added", async () => {
      const { stdout } = await run("git", ["rev-list", "--max-parents=0", "HEAD"], { cwd: root });
      const info = await lookupRepo(join(root, "apps", "web"));
      expect(info).toEqual({ repoId: stdout.trim(), branch: "trunk", relativeCwd: "apps/web" });
      await run("git", ["remote", "add", "origin", "https://github.com/org/proj.git"], {
        cwd: root,
      });
      expect((await lookupRepo(root)).repoId).toBe("github.com/org/proj");
    });

    it("tags published events through the sink", async () => {
      const seen: (PublishOptions | undefined)[] = [];
      const sink = new RepoTaggingSink(
        { publish: (_e, o) => void seen.push(o) },
        new RepoResolver(),
      );
      const event = { ...prompt(SESSION_A, "x"), projectPath: root };
      // The first publish doesn't wait for git; the answer follows on its own.
      await sink.publish([event]);
      expect(seen[0]?.repos).toBeUndefined();
      await sink.settled();
      expect(seen[1]?.repos?.[root]).toMatchObject({ branch: "trunk", relativeCwd: "" });
      // Later publishes carry it straight away.
      await sink.publish([event]);
      expect(seen[2]?.repos?.[root]).toMatchObject({ branch: "trunk" });
    });
  });
});
