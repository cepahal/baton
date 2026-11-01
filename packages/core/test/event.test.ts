import { describe, expect, it } from "vitest";
import { BatonEvent } from "../src/index.js";

const valid = {
  id: "evt-1",
  sessionId: "00000000-0000-4000-8000-000000000001",
  projectPath: "/home/dev/project",
  ts: "2026-11-01T12:00:00.000Z",
  seq: 0,
  kind: "tool_call",
  text: "Bash: pnpm check",
  meta: { toolName: "Bash", toolUseId: "toolu_01" },
};

describe("BatonEvent", () => {
  it("accepts a valid event", () => {
    expect(BatonEvent.parse(valid)).toEqual(valid);
  });

  it("accepts an event without meta", () => {
    const { meta: _meta, ...rest } = valid;
    expect(BatonEvent.safeParse(rest).success).toBe(true);
  });

  it("rejects an unknown kind", () => {
    expect(BatonEvent.safeParse({ ...valid, kind: "summary" }).success).toBe(false);
  });

  it("rejects a missing required field", () => {
    const { sessionId: _sessionId, ...rest } = valid;
    expect(BatonEvent.safeParse(rest).success).toBe(false);
  });

  it("rejects a negative or fractional seq", () => {
    expect(BatonEvent.safeParse({ ...valid, seq: -1 }).success).toBe(false);
    expect(BatonEvent.safeParse({ ...valid, seq: 1.5 }).success).toBe(false);
  });

  it("rejects a non-ISO timestamp", () => {
    expect(BatonEvent.safeParse({ ...valid, ts: "yesterday" }).success).toBe(false);
  });
});
