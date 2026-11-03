import { randomBytes, timingSafeEqual } from "node:crypto";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, posix, resolve, win32 } from "node:path";
import {
  type Handoff,
  type HandoffOfferMessage,
  type HandoffStatusMessage,
  handoffFilePath,
  handoffPrompt,
  type RepoInfo,
} from "@baton/core";
import type { Logger } from "pino";
import { z } from "zod";
import { type GitExec, gitExec } from "./git-exec.js";
import type { Notifier } from "./notify.js";
import { lookupRepo } from "./repo-info.js";
import { repoRoot } from "./session-domains.js";
import { type Launcher, type TerminalCommand, terminalCommand } from "./terminal.js";

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
  /** Sends an answer back: to the local handoff service, or up the team connection. */
  report: (message: HandoffStatusMessage) => void;
  /** This daemon's own origin, e.g. `http://127.0.0.1:7777`, for notification links. */
  origin: () => string;
  logger: Logger;
  notify?: Notifier | undefined;
  lookup?: FolderLookup;
  git?: GitExec;
  launch?: Launcher | undefined;
  platform?: NodeJS.Platform;
  hasWindowsTerminal?: () => Promise<boolean>;
  /** Remembers the folder chosen per repoId. */
  foldersFile?: string | undefined;
  newToken?: () => string;
};

export type InboxOffer = {
  handoff: Handoff;
  /** The receiving session's cwd, from the server: only a hint, always re-checked here. */
  dir?: string;
  token: string;
  /** What this machine decided; the server's copy lags until it hears back. */
  local: "pending" | "accepted" | "declined";
  checkout?: string;
  written?: string;
  started?: boolean;
};

export type ActionResult<T extends object = object> =
  | ({ ok: true } & T)
  | { ok: false; status: number; error: string; needFolder?: boolean };

const Folders = z.record(z.string(), z.string());

/**
 * The receiving machine's side of handoffs. Messages from the
 * server are only stored and announced; every action on this machine runs
 * from a method that needs the item's token, which only the localhost
 * confirm page holds. Nothing here acts on a message by itself.
 */
export class Inbox {
  readonly #offers = new Map<string, InboxOffer>();
  #folders: Record<string, string> | undefined;

  constructor(readonly options: InboxOptions) {}

  /** A message from the server: stored and announced, nothing more. */
  receive(message: HandoffOfferMessage): void {
    const id = message.handoff.id;
    const prev = this.#offers.get(id);
    if (prev) {
      prev.handoff = message.handoff;
      if (message.dir !== undefined) prev.dir = message.dir;
      // The server still thinks it's pending, so our answer was lost: resend it.
      if (message.handoff.status === "pending" && prev.local !== "pending") {
        this.options.report({ type: "handoff_status", id, status: prev.local });
      }
      return;
    }
    if (message.handoff.status !== "pending") return;
    this.#offers.set(id, {
      handoff: message.handoff,
      ...(message.dir === undefined ? {} : { dir: message.dir }),
      token: this.#token(),
      local: "pending",
    });
    trim(this.#offers);
    this.#announce(
      `Handoff from ${message.handoff.sender}`,
      `A ${{ full: "session handoff", chat: "whole chat", snippet: "snippet" }[message.handoff.kind]} for your ${agentName(message.handoff.to.agent)} session. Open to review it.`,
      `/inbox/${id}`,
    );
  }

  offer(id: string): InboxOffer | undefined {
    return this.#offers.get(id);
  }

  /** What the local viewer may show: no tokens. */
  list(): { id: string; sender: string; kind: string; status: string; url: string }[] {
    return [...this.#offers.values()].reverse().map((o) => ({
      id: o.handoff.id,
      sender: o.handoff.sender,
      kind: o.handoff.kind,
      status: o.local,
      url: `/inbox/${o.handoff.id}`,
    }));
  }

  /** Where the handoff would be written, if this machine already knows. */
  async checkoutFor(offer: InboxOffer): Promise<string | undefined> {
    if (offer.checkout) return offer.checkout;
    const repoId = offer.handoff.from.repoId;
    const lookup = this.options.lookup ?? lookupFolder;
    const folders = await this.#loadFolders();
    for (const candidate of [offer.dir, repoId ? folders[repoId] : undefined]) {
      if (!candidate || !isAbsolute(candidate)) continue;
      const found = await lookup(candidate).catch(() => null);
      if (repoId === null) {
        // Not a git handoff: the receiving session's folder will do.
        if (candidate === offer.dir && (await isDir(candidate))) return found?.root ?? candidate;
        continue;
      }
      if (found && found.repoId === repoId) return found.root;
    }
    return undefined;
  }

  /** Accept: writes the handoff file into the checkout and tells the server. */
  async accept(
    id: string,
    token: string,
    folder?: string,
  ): Promise<ActionResult<{ path: string; prompt: string; checkout: string }>> {
    const offer = this.#offers.get(id);
    if (!offer || !tokenMatches(offer.token, token)) return FORBIDDEN;
    if (offer.local === "declined") return { ok: false, status: 409, error: "already declined" };
    let checkout = offer.checkout;
    if (!checkout && folder !== undefined) {
      const chosen = await this.#useFolder(offer, folder);
      if (!chosen.ok) return chosen;
      checkout = chosen.root;
    }
    checkout ??= await this.checkoutFor(offer);
    if (!checkout) {
      return {
        ok: false,
        status: 409,
        error: offer.handoff.from.repoId
          ? `Where is your checkout of ${offer.handoff.from.repoId}?`
          : "Which folder should the handoff go in?",
        needFolder: true,
      };
    }
    offer.checkout = checkout;
    try {
      offer.written = await this.#writeFile(offer);
    } catch (err) {
      this.options.logger.warn({ err, id }, "could not write the handoff file");
      return { ok: false, status: 500, error: `could not write the handoff file: ${String(err)}` };
    }
    if (offer.local !== "accepted") {
      offer.local = "accepted";
      this.options.report({ type: "handoff_status", id, status: "accepted" });
    }
    return { ok: true, path: offer.written, prompt: handoffPrompt(id), checkout };
  }

  /** Decline: tells the server, nothing more. */
  async decline(id: string, token: string): Promise<ActionResult> {
    const offer = this.#offers.get(id);
    if (!offer || !tokenMatches(offer.token, token)) return FORBIDDEN;
    if (offer.local !== "pending")
      return { ok: false, status: 409, error: `already ${offer.local}` };
    offer.local = "declined";
    this.options.report({ type: "handoff_status", id, status: "declined" });
    return { ok: true };
  }

  /** Opens a terminal in the checkout running the receiving agent on the handoff file. */
  async start(id: string, token: string): Promise<ActionResult<{ command: TerminalCommand }>> {
    const offer = this.#offers.get(id);
    if (!offer || !tokenMatches(offer.token, token)) return FORBIDDEN;
    if (offer.local !== "accepted" || !offer.checkout) {
      return { ok: false, status: 409, error: "accept the handoff first" };
    }
    const platform = this.options.platform ?? process.platform;
    const command = terminalCommand({
      platform,
      agent: offer.handoff.to.agent,
      dir: offer.checkout,
      prompt: handoffPrompt(id),
      hasWindowsTerminal:
        platform === "win32" && (await (this.options.hasWindowsTerminal?.() ?? false)),
    });
    if ("error" in command) return { ok: false, status: 400, error: command.error };
    if (!this.options.launch) return { ok: false, status: 501, error: "no terminal launcher" };
    try {
      await this.options.launch(command, offer.checkout);
    } catch (err) {
      return { ok: false, status: 500, error: `could not open a terminal: ${String(err)}` };
    }
    offer.started = true;
    return { ok: true, command };
  }

  async #useFolder(
    offer: InboxOffer,
    folder: string,
  ): Promise<
    { ok: true; root: string } | { ok: false; status: number; error: string; needFolder: true }
  > {
    const fail = (error: string) => ({
      ok: false as const,
      status: 400,
      error,
      needFolder: true as const,
    });
    const dir = cleanFolder(folder);
    if (!isAbsolute(dir)) return fail("give the full path of the folder");
    if (!(await isDir(dir))) return fail(`${dir} is not a folder`);
    const repoId = offer.handoff.from.repoId;
    const found = await (this.options.lookup ?? lookupFolder)(dir).catch(() => null);
    if (repoId === null) return { ok: true, root: found?.root ?? resolve(dir) };
    if (!found) return fail(`${dir} is not a git checkout`);
    if (found.repoId !== repoId) {
      return fail(`${dir} is a checkout of ${found.repoId ?? "an unknown repo"}, not ${repoId}`);
    }
    const folders = await this.#loadFolders();
    folders[repoId] = found.root;
    await this.#saveFolders();
    return { ok: true, root: found.root };
  }

  async #writeFile(offer: InboxOffer): Promise<string> {
    const checkout = offer.checkout ?? "";
    const id = offer.handoff.id;
    const path = join(checkout, ...handoffFilePath(id).split("/"));
    await mkdir(join(checkout, ".baton", "handoffs"), { recursive: true });
    await writeFile(
      path,
      `${offer.handoff.markdown.trimEnd()}
`,
    );
    await this.#excludeFromGit(checkout);
    return path;
  }

  /** Keeps `.baton/` out of `git status` without touching tracked files. */
  async #excludeFromGit(checkout: string): Promise<void> {
    const git = this.options.git ?? gitExec;
    const out = await git(checkout, ["rev-parse", "--git-path", "info/exclude"]);
    if (out.code !== 0) return;
    const rel = out.stdout.trim();
    if (!rel) return;
    const file = isAbsolute(rel) ? rel : join(checkout, rel);
    const current = await readFile(file, "utf8").catch(() => "");
    if (current.split(/\r?\n/).includes("/.baton/")) return;
    await mkdir(join(file, ".."), { recursive: true });
    await appendFile(file, `${current === "" || current.endsWith("\n") ? "" : "\n"}/.baton/\n`);
  }

  async #loadFolders(): Promise<Record<string, string>> {
    if (this.#folders) return this.#folders;
    this.#folders = {};
    const file = this.options.foldersFile;
    if (file) {
      try {
        const parsed = Folders.safeParse(JSON.parse(await readFile(file, "utf8")));
        if (parsed.success) this.#folders = parsed.data;
      } catch {
        // missing or corrupt: start empty
      }
    }
    return this.#folders;
  }

  async #saveFolders(): Promise<void> {
    const file = this.options.foldersFile;
    if (!file || !this.#folders) return;
    try {
      await mkdir(join(file, ".."), { recursive: true });
      await writeFile(file, JSON.stringify(this.#folders, null, 2));
    } catch (err) {
      this.options.logger.warn({ err, file }, "could not save repo folders");
    }
  }

  #announce(title: string, body: string, path: string): void {
    const url = `${this.options.origin()}${path}`;
    this.options.logger.info({ url }, title);
    this.options.notify?.({ title, body, url }).catch((err: unknown) => {
      this.options.logger.warn({ err }, "could not show a notification");
    });
  }

  #token(): string {
    return this.options.newToken?.() ?? randomBytes(24).toString("hex");
  }
}

const FORBIDDEN = { ok: false as const, status: 403, error: "unknown handoff or wrong token" };

function tokenMatches(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

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

const agentName = (agent: string) => (agent === "codex" ? "Codex" : "Claude Code");
