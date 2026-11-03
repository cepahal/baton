import { describe, expect, it } from "vitest";
import { type BatonEvent, maskEventSecrets, maskSecrets, SECRET_MASK } from "../src/index.js";

// Built from pieces so no real-looking key sits in the repo for scanners to flag.
const fake = (prefix: string, n: number, c = "a") => prefix + c.repeat(n);

describe("maskSecrets", () => {
  it.each([
    ["anthropic", fake("sk-" + "ant-api03-", 40)],
    ["openai", fake("sk-" + "proj-", 40)],
    ["github", fake("gh" + "p_", 36)],
    ["github pat", fake("github" + "_pat_", 60)],
    ["gitlab", fake("glp" + "at-", 20)],
    ["aws", fake("AK" + "IA", 16, "Q")],
    ["google", fake("AI" + "za", 35)],
    ["slack", fake("xo" + "xb-", 24, "1")],
    ["stripe", fake("sk" + "_live_", 24)],
    ["npm", fake("np" + "m_", 36)],
    ["jwt", `${fake("ey" + "J", 20)}.${"b".repeat(20)}.${"c".repeat(20)}`],
  ])("masks a %s key", (_name, key) => {
    const out = maskSecrets(`before ${key} after`);
    expect(out).toBe(`before ${SECRET_MASK} after`);
  });

  it("masks a private key block", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE" + " KEY-----",
      "MIIabc",
      "-----END RSA PRIVATE" + " KEY-----",
    ].join("\n");
    expect(maskSecrets(`key:\n${pem}\ndone`)).toBe(`key:\n${SECRET_MASK}\ndone`);
  });

  it("keeps the name of a secret assignment and masks its value", () => {
    expect(maskSecrets("DATABASE_PASSWORD=hunter2hunter2")).toBe(
      `DATABASE_PASSWORD=${SECRET_MASK}`,
    );
    expect(maskSecrets('export STRIPE_SECRET="abcdefgh12345"')).toBe(
      `export STRIPE_SECRET="${SECRET_MASK}"`,
    );
    expect(maskSecrets('"apiKey": "abcdefgh12345678"')).toBe(`"apiKey": "${SECRET_MASK}"`);
  });

  it("leaves references to secrets alone", () => {
    for (const s of [
      "API_KEY=$API_KEY_FROM_VAULT",
      `TOKEN=$${"{"}BATON_TOKEN}`,
      "const token = process.env.BATON_TOKEN",
      "SECRET_NAME=short",
    ]) {
      expect(maskSecrets(s)).toBe(s);
    }
  });

  it("masks passwords in URLs and bearer tokens", () => {
    expect(maskSecrets("postgres://app:s3cretpw@db:5432/x")).toBe(
      `postgres://app:${SECRET_MASK}@db:5432/x`,
    );
    expect(maskSecrets(`curl -H "Authorization: Bearer ${"t".repeat(32)}"`)).toBe(
      `curl -H "Authorization: Bearer ${SECRET_MASK}"`,
    );
  });

  it("leaves ordinary code and prose alone", () => {
    const code = [
      "function getToken(user) { return user.token; }",
      "const tokens = tokenize(input);",
      "The password field is required.",
      "git checkout -b fix/auth-token-refresh",
      "id: 00000000-0000-4000-8000-000000000001",
      "sha256 3f786850e387550fdab836ed7e6dc881de23001b",
    ].join("\n");
    expect(maskSecrets(code)).toBe(code);
  });

  it("is idempotent", () => {
    const once = maskSecrets(`A_TOKEN=abcdefgh1234 ${fake("gh" + "p_", 36)}`);
    expect(maskSecrets(once)).toBe(once);
  });
});

describe("maskEventSecrets", () => {
  const base: BatonEvent = {
    id: "e1",
    agent: "claude-code",
    sessionId: "s1",
    projectPath: "/work/app",
    ts: "2026-11-03T10:00:00.000Z",
    seq: 0,
    kind: "tool_result",
    text: "",
  };

  it("masks text and meta strings but keeps ids", () => {
    const key = fake("gh" + "p_", 36);
    const out = maskEventSecrets({
      ...base,
      text: `token ${key}`,
      meta: { toolUseId: "toolu_1", input: { command: `echo ${key}` }, lines: [key] },
    });
    expect(out.text).toBe(`token ${SECRET_MASK}`);
    expect(out.meta).toEqual({
      toolUseId: "toolu_1",
      input: { command: `echo ${SECRET_MASK}` },
      lines: [SECRET_MASK],
    });
    expect(out.id).toBe("e1");
  });

  it("returns the same event when there's nothing to mask", () => {
    const event = { ...base, text: "all clear" };
    expect(maskEventSecrets(event)).toBe(event);
  });
});
