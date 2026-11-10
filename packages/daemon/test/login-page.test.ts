import { describe, expect, it, vi } from "vitest";
import { LOGIN_PAGE } from "../src/login-page.js";

/** The page's inline script, as the browser receives it. */
function script(): string {
  const match = /<script>([\s\S]*?)<\/script>/.exec(LOGIN_PAGE);
  if (!match?.[1]) throw new Error("the login page has no inline script");
  return match[1];
}

/** Runs the script against a fake page at `href`; returns where a successful login goes. */
async function signIn(href: string): Promise<string> {
  let submit: ((e: { preventDefault(): void }) => Promise<void>) | undefined;
  const elements: Record<
    string,
    { value?: string; textContent?: string; addEventListener?: unknown }
  > = {
    login: {
      addEventListener: (_: string, fn: typeof submit) => {
        submit = fn;
      },
    },
    error: { textContent: "" },
    token: { value: "t" },
  };
  const url = new URL(href);
  const assign = vi.fn();
  const location = { href, origin: url.origin, search: url.search, hash: url.hash, assign };
  const run = new Function("document", "location", "fetch", "URL", "URLSearchParams", script());
  run(
    { getElementById: (id: string) => elements[id] },
    location,
    async () => ({ ok: true, status: 200 }),
    URL,
    URLSearchParams,
  );
  await submit?.({ preventDefault() {} });
  return String(assign.mock.calls[0]?.[0]);
}

describe("login page", () => {
  it("has a script that parses", () => {
    expect(() => new Function(script())).not.toThrow();
  });

  it("goes back to the page that sent the browser here, fragment and all", async () => {
    expect(await signIn("https://baton.test/login")).toBe("/");
    expect(await signIn("https://baton.test/login?next=%2Fhandoffs%2Fhabcdefghij")).toBe(
      "/handoffs/habcdefghij",
    );
    expect(await signIn("https://baton.test/login?next=%2Fpair#code123")).toBe("/pair#code123");
  });

  it("never sends the browser to another site", async () => {
    for (const next of [
      "//evil.test/x",
      "/\\evil.test/x",
      "https://evil.test/",
      "javascript:alert(1)",
    ]) {
      const to = await signIn(`https://baton.test/login?next=${encodeURIComponent(next)}`);
      expect(to, next).toBe("/");
    }
  });
});
