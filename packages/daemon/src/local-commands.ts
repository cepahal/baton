import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { BATON_VERSION } from "@baton/core";
import { type DoctorInput, formatChecks, runDoctor } from "./doctor.js";
import { runHandoffApply, runHandoffStart } from "./handoff-commands.js";
import { loadMachineId } from "./machine-id.js";
import { requestPairLink } from "./pair-client.js";
import { lookupRepo } from "./repo-info.js";
import { buildReport, ISSUES_URL } from "./report.js";
import { EMPTY_SHARING, isInside, readSharing, type Sharing, writeSharing } from "./sharing.js";

/** Commands that act on this machine's settings and exit; no daemon needed. */
export type LocalAction =
  | { kind: "share" | "unshare"; dir: string; sharingFile: string }
  | { kind: "sharing" | "pause" | "resume"; sharingFile: string }
  | { kind: "doctor"; input: DoctorInput }
  | { kind: "report"; logFile: string; token?: string | undefined }
  | { kind: "version" }
  | { kind: "handoff-apply" | "handoff-start"; dir: string; id: string }
  | { kind: "pair"; server: string; token: string; name: string; machineFile: string };

type Out = { write(text: string): void };

/** Runs a local command; resolves its exit code. */
export async function runLocal(
  action: LocalAction,
  out: Out = process.stdout,
  err: Out = process.stderr,
): Promise<number> {
  switch (action.kind) {
    case "handoff-apply":
      return runHandoffApply(action, out, err);
    case "handoff-start":
      return runHandoffStart(action, err);
    case "pair": {
      const machine = await loadMachineId(action.machineFile);
      const result = await requestPairLink({ ...action, machine });
      if (!result.ok) {
        err.write(`baton: ${result.error}
`);
        return 1;
      }
      // The link is a one-time secret: shown to this user only, never logged.
      out.write(
        `Open this link in a browser signed in to the team server to pair it with ${action.name}
(single use, expires ${result.link.expiresAt}):

  ${result.link.url}
`,
      );
      return 0;
    }
    case "version":
      out.write(`baton ${BATON_VERSION}\n`);
      return 0;
    case "doctor": {
      const checks = await runDoctor(action.input);
      out.write(formatChecks(checks));
      return checks.some((c) => c.status === "fail") ? 1 : 0;
    }
    case "report": {
      out.write(
        await buildReport({
          logFile: action.logFile,
          ...(action.token ? { secrets: [action.token] } : {}),
        }),
      );
      out.write(`\nPaste the above into a new issue: ${ISSUES_URL}\n`);
      return 0;
    }
    case "share":
      return share(action.dir, action.sharingFile, out);
    case "unshare":
      return unshare(action.dir, action.sharingFile, out);
    case "sharing":
      out.write(describe(await load(action.sharingFile)));
      return 0;
    case "pause":
    case "resume": {
      const sharing = await load(action.sharingFile);
      await writeSharing(action.sharingFile, { ...sharing, paused: action.kind === "pause" });
      out.write(
        action.kind === "pause"
          ? "Sharing paused: nothing is sent until `baton resume`. Events from now until then are never sent.\n"
          : "Sharing resumed.\n",
      );
      return 0;
    }
  }
}

async function load(file: string): Promise<Sharing> {
  return (await readSharing(file)) ?? EMPTY_SHARING;
}

async function share(dirArg: string, file: string, out: Out): Promise<number> {
  const dir = resolve(dirArg);
  if (
    !(await stat(dir).then(
      (s) => s.isDirectory(),
      () => false,
    ))
  ) {
    out.write(`baton: ${dir} is not a folder\n`);
    return 2;
  }
  const sharing = await load(file);
  const repo = await lookupRepo(dir);
  if (repo.repoId) {
    if (!sharing.repos.includes(repo.repoId)) sharing.repos.push(repo.repoId);
    out.write(`Sharing ${repo.repoId}: sessions in any checkout of it on this machine.\n`);
  } else {
    if (!sharing.folders.some((f) => isInside(f, dir) && isInside(dir, f)))
      sharing.folders.push(dir);
    out.write(`Sharing sessions in ${dir} and its subfolders (not a git repo).\n`);
  }
  out.write(
    "A running daemon sends their new activity from now on. A daemon that starts later also\n" +
      "sends the history of recent sessions here (active in the last 2 hours, and the newest\n" +
      "few per agent). See docs/what-baton-shares.md.\n",
  );
  await writeSharing(file, sharing);
  if (sharing.paused) out.write("Note: sharing is paused; `baton resume` to start sending.\n");
  return 0;
}

async function unshare(dirArg: string, file: string, out: Out): Promise<number> {
  const dir = resolve(dirArg);
  const sharing = await load(file);
  const repo = await lookupRepo(dir).catch(() => undefined);
  const before = sharing.repos.length + sharing.folders.length;
  sharing.repos = sharing.repos.filter((r) => r !== repo?.repoId);
  sharing.folders = sharing.folders.filter((f) => !(isInside(f, dir) && isInside(dir, f)));
  if (sharing.repos.length + sharing.folders.length === before) {
    out.write(`${repo?.repoId ?? dir} wasn't shared.\n`);
    return 0;
  }
  await writeSharing(file, sharing);
  out.write(
    `Stopped sharing ${repo?.repoId ?? dir}. What was already sent stays on the team server until someone removes the session in the viewer.\n`,
  );
  return 0;
}

function describe(sharing: Sharing): string {
  const lines = [sharing.paused ? "Sharing is PAUSED: nothing is sent." : "Sharing is on."];
  if (sharing.repos.length + sharing.folders.length === 0) {
    lines.push("Nothing is shared yet. Run `baton share` inside a repo to share it.");
  }
  for (const r of sharing.repos) lines.push(`  repo    ${r}`);
  for (const f of sharing.folders) lines.push(`  folder  ${f}`);
  return `${lines.join("\n")}\n`;
}
