import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Guards against committing unredacted transcripts. See fixtures/README.md.
const FIXTURE_DIR = join(import.meta.dirname, "fixtures");
const fixtures = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".jsonl"));

const ALLOWED_EMAILS = new Set(["dev@example.com", "noreply@anthropic.com"]);
const ALLOWED_HOME_USERS = new Set(["dev", "Administrator", "Public"]);
const FAKE_UUID = /^00000000-0000-4000-8000-[0-9a-f]{12}$/;

const LEAKS: [string, RegExp][] = [
  ["anthropic key", /sk-ant-[A-Za-z0-9_-]{10,}/],
  ["openai-style key", /\bsk-[A-Za-z0-9_-]{20,}/],
  ["github token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_/],
  ["aws key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["groq/google/slack key", /\b(?:gsk_|AIza|xox[abp]-)[A-Za-z0-9_-]{16,}/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["bearer token", /Bearer\s+(?!REDACTED)[A-Za-z0-9._~+/=-]{16,}/],
  ["long hex", /\b[0-9a-f]{32,}\b/i],
];

function homeUsers(line: string): string[] {
  const users = [...line.matchAll(/\bUsers(?:\\+|\/)([A-Za-z0-9._-]+)/g)].map((m) => m[1] ?? "");
  const slugs = [...line.matchAll(/\b[cC]--Users-([A-Za-z0-9.]+)-/g)].map((m) => m[1] ?? "");
  const homes = [...line.matchAll(/\/home\/([A-Za-z0-9._-]+)/g)].map((m) => m[1] ?? "");
  return [...users, ...slugs, ...homes].filter((u) => !ALLOWED_HOME_USERS.has(u));
}

describe.each(fixtures)("fixture %s", (name) => {
  const lines = readFileSync(join(FIXTURE_DIR, name), "utf8").split("\n").filter(Boolean);

  it("has ~200 records, each a JSON object with a string type", () => {
    expect(lines.length).toBeGreaterThan(50);
    expect(lines.length).toBeLessThanOrEqual(250);
    for (const line of lines) {
      const record: unknown = JSON.parse(line);
      expect(record).toMatchObject({ type: expect.any(String) });
    }
  });

  it("contains no real home-directory usernames", () => {
    const found = new Set(lines.flatMap(homeUsers));
    expect([...found]).toEqual([]);
  });

  it("contains no emails outside the allowlist", () => {
    const emails = lines.flatMap(
      (l) => l.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g) ?? [],
    );
    expect(emails.filter((e) => !ALLOWED_EMAILS.has(e))).toEqual([]);
  });

  it("contains only remapped UUIDs", () => {
    const uuids = lines.flatMap(
      (l) => l.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi) ?? [],
    );
    expect(uuids.filter((u) => !FAKE_UUID.test(u))).toEqual([]);
  });

  it.each(LEAKS)("contains no %s", (_label, pattern) => {
    expect(lines.filter((l) => pattern.test(l)).map((l) => l.match(pattern)?.[0])).toEqual([]);
  });
});
