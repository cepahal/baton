import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { INGEST_PROTOCOL_VERSION, WhoamiResponse } from "@baton/core";
import { httpBase } from "./remote-blobs.js";
import { readSharing } from "./sharing.js";

export type CheckStatus = "ok" | "warn" | "fail";
export type Check = { status: CheckStatus; what: string; fix?: string };

/** Oldest Node Baton supports (root package.json `engines`). */
export const MIN_NODE: readonly [number, number] = [20, 19];
/** Clock difference past which times on the canvas start to look wrong. */
export const SKEW_WARN_MS = 2 * 60_000;

export type DoctorInput = {
  nodeVersion: string;
  projectsDir: string;
  codexDir: string;
  sharingFile: string;
  logFile: string;
  server?: string | undefined;
  token?: string | undefined;
};

export type DoctorDeps = {
  fetch: typeof fetch;
  /** Resolves `git --version` output, or undefined when git can't run. */
  gitVersion: () => Promise<string | undefined>;
  isDir: (path: string) => Promise<boolean>;
  now: () => number;
};

export const defaultDoctorDeps: DoctorDeps = {
  fetch,
  gitVersion: () =>
    new Promise((resolve) => {
      execFile("git", ["--version"], { timeout: 5000, windowsHide: true }, (err, out) =>
        resolve(err ? undefined : out.trim()),
      );
    }),
  isDir: (p) =>
    stat(p).then(
      (s) => s.isDirectory(),
      () => false,
    ),
  now: Date.now,
};

/** Every check `baton doctor` runs, in order. Never throws. */
export async function runDoctor(
  input: DoctorInput,
  deps: DoctorDeps = defaultDoctorDeps,
): Promise<Check[]> {
  const checks: Check[] = [];
  const [major = 0, minor = 0] = input.nodeVersion.replace(/^v/, "").split(".").map(Number);
  const nodeOk = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  checks.push(
    nodeOk
      ? { status: "ok", what: `Node ${input.nodeVersion}` }
      : {
          status: "fail",
          what: `Node ${input.nodeVersion} is too old`,
          fix: `install Node ${MIN_NODE.join(".")} or newer (https://nodejs.org)`,
        },
  );

  const git = await deps.gitVersion();
  checks.push(
    git
      ? { status: "ok", what: git }
      : {
          status: "fail",
          what: "git isn't on PATH",
          fix: "install git; Baton uses it to tell repos apart and to place handoffs",
        },
  );

  const claude = await deps.isDir(input.projectsDir);
  const codex = await deps.isDir(input.codexDir);
  checks.push(
    claude || codex
      ? {
          status: "ok",
          what: `agent logs found: ${[claude && "Claude Code", codex && "Codex"].filter(Boolean).join(", ")}`,
        }
      : {
          status: "warn",
          what: `no agent logs found (looked in ${input.projectsDir} and ${input.codexDir})`,
          fix: "run Claude Code or Codex once, or pass --projects-dir / --codex-dir",
        },
  );

  try {
    const sharing = await readSharing(input.sharingFile);
    const n = (sharing?.repos.length ?? 0) + (sharing?.folders.length ?? 0);
    if (sharing?.paused) {
      checks.push({
        status: "warn",
        what: "sharing is paused",
        fix: "`baton resume` to share again",
      });
    } else if (n === 0) {
      checks.push({
        status: "warn",
        what: "no repos are shared yet, so teammates will see nothing",
        fix: "run `baton share` inside each repo you want to share",
      });
    } else {
      checks.push({
        status: "ok",
        what: `sharing ${n} repo(s)/folder(s) (\`baton sharing\` lists them)`,
      });
    }
  } catch (err) {
    checks.push({ status: "fail", what: `can't read the sharing file: ${String(err)}` });
  }

  if (input.server === undefined) {
    checks.push({
      status: "warn",
      what: "no team server given, so it wasn't checked",
      fix: "run `baton doctor --server ws://<host>:7777` with BATON_TOKEN set",
    });
  } else {
    checks.push(...(await checkServer(input.server, input.token, deps)));
  }
  checks.push({ status: "ok", what: `log file: ${input.logFile}` });
  return checks;
}

async function checkServer(
  server: string,
  token: string | undefined,
  deps: DoctorDeps,
): Promise<Check[]> {
  let base: string;
  try {
    base = httpBase(server);
  } catch {
    return [{ status: "fail", what: `${server} isn't a URL`, fix: "use ws://<host>:7777" }];
  }
  const get = (path: string, headers: Record<string, string> = {}) =>
    deps.fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(5000) });
  try {
    const health = await get("/health");
    if (!health.ok) throw new Error(`HTTP ${health.status}`);
  } catch (err) {
    return [
      {
        status: "fail",
        what: `can't reach the team server at ${base} (${err instanceof Error ? err.message : String(err)})`,
        fix: "check Tailscale is connected, the host and port, and that `baton serve` is running",
      },
    ];
  }
  const checks: Check[] = [{ status: "ok", what: `team server reachable at ${base}` }];
  if (token === undefined) {
    checks.push({ status: "fail", what: "BATON_TOKEN isn't set", fix: "set it to the team token" });
    return checks;
  }
  const sentAt = deps.now();
  let res: Response;
  try {
    res = await get("/whoami", { authorization: `Bearer ${token}` });
  } catch (err) {
    checks.push({ status: "fail", what: `token check failed: ${String(err)}` });
    return checks;
  }
  if (res.status === 401) {
    checks.push({
      status: "fail",
      what: "the team server rejected BATON_TOKEN",
      fix: "ask for the current team token",
    });
    return checks;
  }
  if (res.status === 404) {
    checks.push({
      status: "fail",
      what: "the team server is older than this Baton (no /whoami)",
      fix: "ask whoever runs the team server to update it",
    });
    return checks;
  }
  const body = WhoamiResponse.safeParse(await res.json().catch(() => undefined));
  if (!res.ok || !body.success) {
    checks.push({
      status: "fail",
      what: `unexpected answer from the team server (HTTP ${res.status})`,
    });
    return checks;
  }
  checks.push({ status: "ok", what: "team token accepted" });
  const { protocol, app, now } = body.data;
  checks.push(
    protocol === INGEST_PROTOCOL_VERSION
      ? { status: "ok", what: `team server runs Baton ${app} (compatible)` }
      : {
          status: "fail",
          what: `team server runs Baton ${app} (protocol ${protocol}; this Baton speaks ${INGEST_PROTOCOL_VERSION})`,
          fix:
            protocol > INGEST_PROTOCOL_VERSION
              ? "update Baton on this machine"
              : "ask whoever runs the team server to update it",
        },
  );
  const midpoint = (sentAt + deps.now()) / 2;
  const skew = Date.parse(now) - midpoint;
  checks.push(
    Math.abs(skew) <= SKEW_WARN_MS
      ? {
          status: "ok",
          what: `clock within ${Math.max(1, Math.round(Math.abs(skew) / 1000))} s of the server`,
        }
      : {
          status: "warn",
          what: `clock is ${Math.round(Math.abs(skew) / 1000)} s ${skew > 0 ? "behind" : "ahead of"} the server`,
          fix: "turn on automatic time sync; session times and 'active' badges will look wrong",
        },
  );
  return checks;
}

const MARK: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✗" };

export function formatChecks(checks: readonly Check[]): string {
  const lines = checks.map((c) => `${MARK[c.status]} ${c.what}${c.fix ? `\n    → ${c.fix}` : ""}`);
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  lines.push(
    "",
    fails > 0 ? `${fails} problem(s) to fix.` : warns > 0 ? "OK, with warnings." : "All good.",
  );
  return `${lines.join("\n")}\n`;
}
