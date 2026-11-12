import { describe, expect, it } from "vitest";
import type { BatonEvent, JsonValue } from "../src/event.js";
import { fileTouches, hunkRanges, mergeRanges } from "../src/files/touches.js";

const call = (toolName: string, input: JsonValue): BatonEvent => ({
  id: "e1",
  agent: "claude-code",
  sessionId: "s1",
  projectPath: "/w",
  ts: "2026-11-01T12:00:00.000Z",
  seq: 1,
  kind: "tool_call",
  text: toolName,
  meta: { toolName, toolUseId: "t1", input },
});

describe("fileTouches", () => {
  it("reads Claude edits: file only for Edit, whole content for Write", () => {
    expect(fileTouches(call("Edit", { file_path: "/w/a.ts", old_string: "x" }))).toEqual([
      { path: "/w/a.ts", ranges: [] },
    ]);
    expect(fileTouches(call("MultiEdit", { file_path: "/w/a.ts", edits: [] }))).toEqual([
      { path: "/w/a.ts", ranges: [] },
    ]);
    expect(fileTouches(call("Write", { file_path: "/w/b.ts", content: "a\nb\nc" }))).toEqual([
      { path: "/w/b.ts", ranges: [[1, 3]] },
    ]);
    expect(fileTouches(call("Write", { file_path: "/w/e.ts", content: "" }))).toEqual([
      { path: "/w/e.ts", ranges: [] },
    ]);
    expect(fileTouches(call("NotebookEdit", { notebook_path: "/w/n.ipynb" }))).toEqual([
      { path: "/w/n.ipynb", ranges: [] },
    ]);
  });

  it("reads Codex patches: added files and diff hunks", () => {
    const patch = call("Patch", {
      "/w/new.py": { type: "add", content: "x = 1\ny = 2\n" },
      "/w/old.py": {
        type: "update",
        unified_diff: "@@ -1,3 +1,4 @@\n a\n+b\n@@ -20 +21 @@\n-x\n+y\n@@ -40,2 +41,0 @@\n-gone\n",
      },
      "/w/del.py": { type: "delete" },
    });
    expect(fileTouches(patch)).toEqual([
      { path: "/w/new.py", ranges: [[1, 2]] },
      {
        path: "/w/old.py",
        ranges: [
          [1, 4],
          [21, 21],
          [41, 41],
        ],
      },
      { path: "/w/del.py", ranges: [] },
    ]);
  });

  it("reads Cursor file tool paths and content, and ignores malformed paths", () => {
    expect(fileTouches(call("Write", { path: "/w/new.ts", contents: "a\nb" }))).toEqual([
      { path: "/w/new.ts", ranges: [[1, 2]] },
    ]);
    expect(fileTouches(call("StrReplace", { path: "/w/edit.ts", new_string: "next" }))).toEqual([
      { path: "/w/edit.ts", ranges: [] },
    ]);
    expect(fileTouches(call("Delete", { path: "/w/old.ts" }))).toEqual([
      { path: "/w/old.ts", ranges: [] },
    ]);
    expect(fileTouches(call("Write", { path: 42, contents: "ignored" }))).toEqual([]);
  });

  it("ignores reads, other kinds and malformed input", () => {
    expect(fileTouches(call("Read", { file_path: "/w/a.ts" }))).toEqual([]);
    expect(fileTouches(call("Edit", { file_path: 3 }))).toEqual([]);
    expect(fileTouches(call("Write", null))).toEqual([]);
    expect(fileTouches(call("Patch", ["nope"]))).toEqual([]);
    expect(fileTouches({ ...call("Edit", { file_path: "/w/a" }), kind: "tool_result" })).toEqual(
      [],
    );
  });
});

describe("line ranges", () => {
  it("merges overlapping and touching ranges", () => {
    expect(
      mergeRanges([
        [10, 12],
        [1, 3],
        [4, 5],
        [11, 20],
        [30, 30],
      ]),
    ).toEqual([
      [1, 5],
      [10, 20],
      [30, 30],
    ]);
  });

  it("finds no hunks in text without headers", () => {
    expect(hunkRanges("just text")).toEqual([]);
  });
});
