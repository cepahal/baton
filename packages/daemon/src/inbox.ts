import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve, win32 } from "node:path";
import {
  type Handoff,
  type HandoffApply,
  type HandoffOfferMessage,
  type HandoffWriteResult,
  handoffFilePath,
  handoffPatchPath,
  type RepoInfo,
  safeFileName,
} from "@baton/core";
import type { Logger } from "pino";
import { type GitExec, gitExec } from "./git-exec.js";
import { HandoffMeta } from "./handoff-meta.js";
import type { Notifier } from "./notify.js";
import { lookupRepo } from "./repo-info.js";
import { repoRoot } from "./session-domains.js";

/** Offers kept; beyond it the oldest go. */
const MAX_ITEMS = 200;

/** Where a folder sits in git: its checkout root and repoId, or null outside git. */
export type FolderLookup = (dir: string) => Promise<{ root: string; repoId: string | null } | null>;

/**
 * A folder as typed or pasted: surrounding quotes (Explorer's "Copy as path")
 * dropped, and doubled separators (`C:\Users`, copied from an escaped string)
 * collapsed, so git and the repo-relative path agree on it.
 */
export function cleanFolder(folder: string, platform: NodeJS.Platform = process.platform): string {
  const dir = folder
    .trim()
    .replace(/^(["'])(.*)\1$/, "$2")
    .trim();
  if (dir === "") return dir;
  return platform === "win32" ? win32.normalize(dir) : posix.normalize(dir);
}

export const lookupFolder: FolderLookup = async (dir) => {
  const info: RepoInfo = await lookupRepo(dir);
  if (info.relativeCwd === null) return null;
  return { root: repoRoot(dir, info.relativeCwd), repoId: info.repoId };
};

export type InboxOptions = {
  /** Where handoff pages live (the team server, or this daemon on `baton start`), for notification links. */
  origin: () => string;
  logger: Logger;
  notify?: Notifier | undefined;
  lookup?: FolderLookup;
  git?: GitExec;
  platform?: NodeJS.Platform;
  /** The working directory of one of this machine's sessions, if it is known here. */
  sessionDir?: (sessionId: string) => string | undefined;
  /** Reads a note file or patch from the hub. */
  fetchBlob?: (sha256: string) => Promise<Uint8Array | undefined>;
};

/**
 * A daemon's handoff inbox: the pending handoffs addressed to this machine's
 * sessions. It notifies the user about new ones, and on `write` (Accept in a
 * browser paired to this machine) writes one into a folder. That is all it
 * does: it never runs the receiver's agent, a terminal, or `git apply`.
 */
export class Inbox {
  readonly #offers = new Map<string, Handoff>();

  constructor(readonly options: InboxOptions) {}

  /**
   * The hub's latest copy of a handoff. A new pending one is stored and
   * announced; one that is no longer pending is forgotten.
   */
  receive(message: HandoffOfferMessage): void {
    const handoff = message.handoff;
    if (handoff.status !== "pending") {
      this.#offers.delete(handoff.id);
      return;
    }
    const known = this.#offers.has(handoff.id);
    this.#offers.set(handoff.id, handoff);
    trim(this.#offers);
    if (known) return;
    const kind = KIND_NAMES[handoff.kind];
    this.#announce(
      `Handoff from ${handoff.sender}`,
      `A ${kind} for your ${agentName(handoff.to.agent)} session.`,
      `/handoffs/${handoff.id}`,
    );
  }

  /** A pending handoff for this machine, by id. */
  offer(id: string): Handoff | undefined {
    return this.#offers.get(id);
  }

  /**
   * Writes a pending handoff into `folder`, or the receiving session's folder
   * when none is given: the markdown, its note files, the sender's patch and a
   * `handoff.json` for `baton handoff apply`/`start`. `.baton/` is kept out of
   * `git status`. The folder only has to exist; any repo, or none, will do.
   */
  async write(id: string, folder?: string): Promise<HandoffWriteResult> {
    const handoff = this.#offers.get(id);
    if (!handoff) {
      return { ok: false, error: "This machine has no pending handoff with that id." };
    }
    const dest = await this.#destination(handoff, folder);
    if ("error" in dest) return { ok: false, ...dest };
    try {
      const path = await this.#writeFiles(handoff, dest.dir);
      const apply = await this.#applyCheck(handoff, dest.dir);
      this.options.logger.info({ id, folder: dest.dir }, "handoff written");
      return { ok: true, delivery: { folder: dest.dir, path, apply } };
    } catch (err) {
      this.options.logger.warn({ err, id }, "could not write a handoff");
      return { ok: false, error: `Could not write the handoff: ${errorText(err)}` };
    }
  }

  async #destination(
    handoff: Handoff,
    folder: string | undefined,
  ): Promise<{ dir: string } | { error: string; needFolder?: boolean }> {
    if (folder !== undefined) {
      const dir = cleanFolder(folder, this.#platform);
      const pathApi = this.#platform === "win32" ? win32 : posix;
      if (dir === "" || !pathApi.isAbsolute(dir)) {
        return {
          error: "Give the full path of a folder on the receiving machine.",
          needFolder: true,
        };
      }
      if (!(await isDir(dir))) {
        return { error: `${dir} is not a folder on the receiving machine.`, needFolder: true };
      }
      return { dir: resolve(dir) };
    }
    const dir = this.options.sessionDir?.(handoff.to.sessionId);
    if (dir !== undefined && (await isDir(dir))) return { dir };
    return {
      error: "This machine doesn't know the receiving session's folder. Choose one.",
      needFolder: true,
    };
  }

  async #writeFiles(handoff: Handoff, dir: string): Promise<string> {
    const id = handoff.id;
    const path = join(dir, ...handoffFilePath(id).split("/"));
    const filesDir = join(dir, ".baton", "handoffs", id);
    await mkdir(join(dir, ".baton", "handoffs"), { recursive: true });
    const saved = await this.#writeAttachments(handoff, filesDir);
    const patch = await this.#writePatch(handoff, filesDir);
    const meta: HandoffMeta = {
      id,
      agent: handoff.to.agent,
      sender: handoff.sender,
      repoId: handoff.from.repoId,
      branch: handoff.code?.branch ?? handoff.from.branch,
      base: handoff.code?.base ?? null,
      patch: patch !== "",
    };
    await mkdir(filesDir, { recursive: true });
    await writeFile(
      join(filesDir, "handoff.json"),
      `${JSON.stringify(HandoffMeta.parse(meta), null, 2)}\n`,
    );
    await writeFile(path, `${handoff.markdown.trimEnd()}\n${saved}${patch}`);
    await this.#excludeFromGit(dir);
    return path;
  }

  /**
   * Writes a note handoff's files into `.baton/handoffs/<id>/` and returns a
   * markdown section listing where they went (empty without attachments).
   */
  async #writeAttachments(handoff: Handoff, dir: string): Promise<string> {
    const files = handoff.attachments ?? [];
    if (files.length === 0) return "";
    const lines = ["", "## Files saved with this handoff", ""];
    const used = new Set<string>(["changes.patch", "handoff.json"]);
    for (const f of files) {
      let name = safeFileName(f.name);
      for (let n = 2; used.has(name.toLowerCase()); n++) name = `${n}-${safeFileName(f.name)}`;
      used.add(name.toLowerCase());
      const rel = `.baton/handoffs/${handoff.id}/${name}`;
      const bytes = await this.#fetch(f.sha256, handoff.id);
      if (!bytes) {
        lines.push(`- \`${name}\`: _could not be fetched from the hub_`);
        continue;
      }
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, name), bytes);
      lines.push(`- \`${rel}\``);
    }
    return `${lines.join("\n")}\n`;
  }

  /** Writes `changes.patch` and returns the markdown section about it (empty without one). */
  async #writePatch(handoff: Handoff, dir: string): Promise<string> {
    const code = handoff.code;
    if (code?.state !== "attached" || code.sha256 === undefined) return "";
    const bytes = await this.#fetch(code.sha256, handoff.id);
    const rel = handoffPatchPath(handoff.id);
    if (!bytes) {
      return `\n## The sender's changes\n\nThe sender attached a patch, but it could not be fetched from the hub.\n`;
    }
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "changes.patch"), bytes);
    const files = code.files ?? [];
    const lines = [
      "",
      "## The sender's changes",
      "",
      `The sender's uncommitted changes are in \`${rel}\`${code.base ? `, against commit \`${code.base.slice(0, 12)}\`` : ""}${code.branch ? ` on \`${code.branch}\`` : ""}.`,
      "This folder may be a different repository or version: read the patch and adapt the changes to this codebase rather than applying it blindly.",
    ];
    if (files.length > 0) {
      lines.push("", "Files in the patch:", "");
      for (const f of files.slice(0, 50)) lines.push(`- \`${f}\``);
      if (files.length > 50) lines.push(`- …and ${files.length - 50} more`);
    }
    return `${lines.join("\n")}\n`;
  }

  async #fetch(sha256: string, id: string): Promise<Uint8Array | undefined> {
    return this.options.fetchBlob?.(sha256).catch((err: unknown) => {
      this.options.logger.warn({ err, id }, "could not fetch a handoff file");
      return undefined;
    });
  }

  /**
   * Whether `baton handoff apply` can work here: only in a checkout of the
   * sender's repo that has the patch's base commit. Otherwise, why not.
   */
  async #applyCheck(handoff: Handoff, dir: string): Promise<HandoffApply> {
    const code = handoff.code;
    if (code?.state !== "attached") {
      return { available: false, reason: "The sender didn't attach code changes." };
    }
    if (code.base === undefined) {
      return { available: false, reason: "The patch doesn't say which commit it is against." };
    }
    const repo = await (this.options.lookup ?? lookupFolder)(dir);
    if (repo === null) {
      return {
        available: false,
        reason:
          "The destination isn't a git checkout. The patch is saved for your agent to adapt by hand.",
      };
    }
    if (handoff.from.repoId === null || repo.repoId !== handoff.from.repoId) {
      return {
        available: false,
        reason:
          "The destination is a different repository from the sender's. Your agent can adapt changes.patch by hand.",
      };
    }
    const git = this.options.git ?? gitExec;
    const has = await git(repo.root, ["cat-file", "-e", `${code.base}^{commit}`]);
    if (has.code !== 0) {
      return {
        available: false,
        reason: `The sender's base commit ${code.base.slice(0, 12)} isn't in this checkout. Run git fetch and accept again, or adapt changes.patch by hand.`,
      };
    }
    return { available: true };
  }

  /** Keeps `.baton/` out of `git status` without touching tracked files. */
  async #excludeFromGit(dir: string): Promise<void> {
    const repo = await (this.options.lookup ?? lookupFolder)(dir);
    if (repo === null) return;
    const git = this.options.git ?? gitExec;
    const out = await git(repo.root, ["rev-parse", "--git-path", "info/exclude"]);
    if (out.code !== 0) return;
    const rel = out.stdout.trim();
    if (!rel) return;
    const file = isAbsolute(rel) ? rel : join(repo.root, rel);
    const sub = relative(repo.root, dir)
      .split(/[\\/]+/)
      .filter(Boolean)
      .join("/");
    const line = sub === "" ? "/.baton/" : `/${sub}/.baton/`;
    const current = await readFile(file, "utf8").catch(() => "");
    if (current.split(/\r?\n/).includes(line)) return;
    await mkdir(join(file, ".."), { recursive: true });
    await appendFile(file, `${current === "" || current.endsWith("\n") ? "" : "\n"}${line}\n`);
  }

  get #platform(): NodeJS.Platform {
    return this.options.platform ?? process.platform;
  }

  #announce(title: string, body: string, path: string): void {
    const url = `${this.options.origin()}${path}`;
    this.options.logger.info({ url }, title);
    this.options.notify?.({ title, body, url }).catch((err: unknown) => {
      this.options.logger.warn({ err }, "could not show a notification");
    });
  }
}

const KIND_NAMES: Record<Handoff["kind"], string> = {
  full: "session handoff",
  chat: "whole chat",
  snippet: "snippet",
  note: "sticky note",
};

function trim<T>(map: Map<string, T>): void {
  while (map.size > MAX_ITEMS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const agentName = (agent: string) =>
  agent === "codex" ? "Codex" : agent === "cursor" ? "Cursor" : "Claude Code";
