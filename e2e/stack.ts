import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentId,
  EventsResponse,
  HandoffsResponse,
  parseSession,
  type SessionInfo,
  SessionsResponse,
} from "@baton/core";
import type { Page } from "@playwright/test";

/** What the Docker stack (docker-compose.test.yml) is driven with; see scripts/multi/fleet.mjs. */
export const TOKEN = process.env.BATON_TOKEN ?? "baton-multi-machine-test-token";
export const BASE = `http://127.0.0.1:${process.env.BATON_TEST_PORT ?? "17777"}`;
const ROOT = join(import.meta.dirname, "..");
const FIXTURES = join(ROOT, "packages/core/test/fixtures");

/** The machines `pnpm test:e2e` starts, and what each replays. */
export const MACHINES = {
  alice: { fixture: "heavy-tools.jsonl", agent: "claude-code" },
  bob: { fixture: "api-requests.jsonl", agent: "claude-code" },
  grace: { fixture: "codex/speech-tool.rollout.jsonl", agent: "codex" },
} as const satisfies Record<string, { fixture: string; agent: AgentId }>;
export type Machine = keyof typeof MACHINES;

/** How many events a machine's whole replay makes, per the parser. */
export function expectedEvents(machine: Machine): number {
  const m = MACHINES[machine];
  return parseSession(m.agent, readFileSync(join(FIXTURES, m.fixture), "utf8")).events.length;
}

function compose(args: readonly string[]): string {
  return execFileSync(
    "docker",
    ["compose", "-f", "docker-compose.test.yml", "-p", "baton-test", ...args],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

/** Cuts a machine off the stack's network for `ms`, then plugs it back in. */
export async function cutNetwork(machine: Machine, ms: number): Promise<void> {
  const container = compose(["ps", "-q", machine]);
  const docker = (...args: string[]) => execFileSync("docker", args, { cwd: ROOT });
  docker("network", "disconnect", "baton-test_default", container);
  try {
    await new Promise((r) => setTimeout(r, ms));
  } finally {
    docker("network", "connect", "baton-test_default", container);
  }
}

/** Runs a shell command on one simulated machine. */
export const onMachine = (machine: Machine, script: string): string =>
  compose(["exec", "-T", machine, "sh", "-c", script]);

/** Runs a Node ES module on one simulated machine, as if the user did it there. */
export const nodeOnMachine = (machine: Machine, code: string): string =>
  compose(["exec", "-T", machine, "node", "--input-type=module", "-e", code]);

async function api(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
  return res.json();
}

export const sessions = async (): Promise<SessionInfo[]> =>
  SessionsResponse.parse(await api("/sessions")).sessions;

export async function sessionOf(machine: Machine): Promise<SessionInfo | undefined> {
  return (await sessions()).find((s) => s.source === machine);
}

/** Every event the server holds for one session, in hub order. */
export async function eventsOf(sessionId: string) {
  const out: EventsResponse["events"] = [];
  let after = 0;
  for (;;) {
    const page = EventsResponse.parse(await api(`/events?after=${after}&limit=5000`));
    out.push(...page.events.filter((e) => e.event.sessionId === sessionId));
    const last = page.events.at(-1)?.seq;
    if (last === undefined || last >= page.lastSeq) return out;
    after = last;
  }
}

export const handoffs = async () => HandoffsResponse.parse(await api("/handoffs")).handoffs;

/** Polls until `get` returns something truthy. */
export async function until<T>(
  get: () => Promise<T | undefined | false>,
  what: string,
  timeoutMs = 120_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await get().catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Signs a browser in through the sign-in page, as a teammate would. */
export async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForURL(/\/login$/);
  await page.locator("#token").fill(TOKEN);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname === "/");
}

/** A valid 4×4 PNG: enough for an <img> to decode, so naturalWidth is 4. */
export const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGP436UNRwzEcQDSEhtBLOt14gAAAABJRU5ErkJggg==",
  "base64",
);
