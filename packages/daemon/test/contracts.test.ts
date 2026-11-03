import type { BatonEvent, RepoInfo } from "@baton/core";
import { describe, expect, it } from "vitest";
import { MemoryEventLog } from "../src/event-log.js";
import { Hub } from "../src/hub.js";
import { SessionContracts } from "../src/session-contracts.js";
import { absolutePath } from "../src/session-files.js";
import { silent } from "./helpers.js";

const ROOT = "/home/dev/shop";
let n = 0;
const write = (sessionId: string, file: string, content: string, cwd = ROOT): BatonEvent => ({
  id: `c${++n}`,
  agent: "claude-code",
  sessionId,
  projectPath: cwd,
  ts: "2026-11-03T01:00:00.000Z",
  seq: n,
  kind: "tool_call",
  text: "Write",
  meta: { toolName: "Write", toolUseId: `t${n}`, input: { file_path: file, content } },
});
const editOf = (sessionId: string, file: string, newString: string): BatonEvent => ({
  ...write(sessionId, file, ""),
  text: "Edit",
  meta: {
    toolName: "Edit",
    toolUseId: `t${n}`,
    input: { file_path: file, old_string: "x", new_string: newString },
  },
});

const fields = (k: number) => Array.from({ length: k }, (_, i) => `f${i}: string;`).join(" ");
const repo: RepoInfo = { repoId: "github.com/acme/shop", branch: "main", relativeCwd: null };

const hub = (maxSessions?: number) =>
  new Hub({
    log: new MemoryEventLog({ maxBytes: 4 * 1024 * 1024, maxEvents: 10_000 }),
    activeWindowMs: 24 * 60 * 60_000,
    logger: silent,
    now: () => Date.parse("2026-11-03T01:00:30.000Z"),
    ...(maxSessions === undefined ? {} : { maxSessions }),
  });

describe("SessionContracts", () => {
  const entries = (...ids: string[]) =>
    new Map(ids.map((id) => [id, { sessionId: id, domain: undefined, root: ROOT, group: "g" }]));

  it("finds a mismatch between two sessions of one repo, and nothing for one alone", () => {
    const c = new SessionContracts();
    c.record(write("fe", `${ROOT}/web/types.ts`, `interface Order { ${fields(47)} }`));
    expect(c.issues(entries("fe")).size).toBe(0);
    c.record(write("be", `${ROOT}/api/types.ts`, `interface Order { ${fields(36)} }`));
    const issues = c.issues(entries("fe", "be"));
    expect(issues.get("fe")?.[0]?.message).toContain("47 fields here vs 36 there");
    expect(issues.get("be")?.[0]?.otherSessionId).toBe("fe");
  });

  it("only compares sessions in the same group", () => {
    const c = new SessionContracts();
    c.record(write("fe", `${ROOT}/web/types.ts`, `interface Order { ${fields(10)} }`));
    c.record(write("be", `${ROOT}/api/types.ts`, `interface Order { ${fields(4)} }`));
    const split = new Map([
      ["fe", { sessionId: "fe", domain: undefined, root: ROOT, group: "a" }],
      ["be", { sessionId: "be", domain: undefined, root: ROOT, group: "b" }],
    ]);
    expect(c.issues(split).size).toBe(0);
  });

  it("lets a whole-file rewrite clear what the file said, and edits add to it", () => {
    const c = new SessionContracts();
    c.record(write("fe", `${ROOT}/web/api.ts`, 'fetch("/api/cart/checkout", { method: "POST" });'));
    c.record(write("be", `${ROOT}/api/server.ts`, 'app.get("/api/cart", list);'));
    expect(c.issues(entries("fe", "be")).get("fe")?.[0]?.kind).toBe("route");
    // The backend adds the route in an edit: issue gone.
    c.record(editOf("be", `${ROOT}/api/server.ts`, 'app.post("/api/cart/checkout", co);'));
    expect(c.issues(entries("fe", "be")).size).toBe(0);
    // The frontend rewrites its file without the call: still nothing.
    c.record(write("fe", `${ROOT}/web/api.ts`, "export {};"));
    expect(c.issues(entries("fe", "be")).size).toBe(0);
  });

  it("caches until a write changes something, and forgets sessions", () => {
    const c = new SessionContracts();
    c.record(write("fe", `${ROOT}/web/t.ts`, `interface Order { ${fields(8)} }`));
    c.record(write("be", `${ROOT}/api/t.ts`, `interface Order { ${fields(5)} }`));
    const first = c.issues(entries("fe", "be"));
    expect(c.issues(entries("fe", "be"))).toBe(first);
    c.forget("be");
    expect(c.issues(entries("fe", "be")).size).toBe(0);
  });
});

describe("absolutePath", () => {
  it.each([
    ["src/a.ts", "/r", "/r/src/a.ts"],
    ["../b/a.ts", "/r/x", "/r/b/a.ts"],
    ["C:\\r\\a.ts", "D:/z", "C:/r/a.ts"],
    ["a.ts", "C:\\r\\", "C:/r/a.ts"],
    ["\\\\srv\\share\\a.ts", "", "//srv/share/a.ts"],
    ["a.ts", "//srv/share/p", "//srv/share/p/a.ts"],
  ])("%s in %s → %s", (path, cwd, want) => {
    expect(absolutePath(path, cwd)).toBe(want);
  });
});

describe("Hub", () => {
  it("puts contract issues on /sessions entries of the same repo", () => {
    const h = hub();
    h.publish(
      [
        write("fe", `${ROOT}/web/types.ts`, `export interface Order { ${fields(47)} }`),
        write("be", `${ROOT}/api/models.ts`, `export interface Order { ${fields(36)} }`),
      ],
      { repos: { [ROOT]: repo } },
    );
    const byId = new Map(h.sessions().map((s) => [s.sessionId, s]));
    expect(byId.get("fe")?.contractIssues?.[0]?.message).toContain("47 fields here vs 36 there");
    expect(byId.get("be")?.contractIssues?.length).toBe(1);
    expect(h.session("fe")?.contractIssues?.[0]?.kind).toBe("shape");
  });

  it("forgets the least recently seen sessions past maxSessions", () => {
    let now = Date.parse("2026-11-03T01:00:00.000Z");
    const h = new Hub({
      log: new MemoryEventLog({ maxBytes: 4 * 1024 * 1024, maxEvents: 10_000 }),
      activeWindowMs: 24 * 60 * 60_000,
      logger: silent,
      now: () => now,
      maxSessions: 3,
    });
    for (const id of ["s1", "s2", "s3", "s4", "s5"]) {
      now += 1000;
      h.publish([write(id, `${ROOT}/web/${id}.ts`, `interface T${id} { a: string }`)]);
    }
    expect(
      h
        .sessions()
        .map((s) => s.sessionId)
        .sort(),
    ).toEqual(["s3", "s4", "s5"]);
  });
});
