import { randomBytes } from "node:crypto";
import {
  buildHandoffDraft,
  type Handoff,
  type HandoffCode,
  type HandoffCreate,
  type HandoffDraft,
  type HandoffDraftRequest,
  type HandoffParty,
  type HandoffView,
  type Pairing,
  renderHandoff,
  summarizerInput,
  withFiles,
} from "@baton/core";
import type { Logger } from "pino";
import type { BlobStore } from "./blob-store.js";
import type { HandoffRoute } from "./handoff-route.js";
import type { HandoffRecord, HandoffStore } from "./handoff-store.js";
import type { Hub } from "./hub.js";
import type { NoteStore } from "./note-store.js";
import type { Summarizer } from "./summarizer.js";

/**
 * Who is asking, for the routes that act on a machine. `local`: `baton start`,
 * whose only browser is this machine's. Otherwise the browser's pairing (see
 * docs/handoff.md), or null when it isn't paired.
 */
export type Asker = { local: true } | { local: false; pairing: Pairing | null };

export type HandoffServiceOptions = {
  hub: Hub;
  store: HandoffStore;
  route: HandoffRoute;
  logger: Logger;
  summarize?: Summarizer | undefined;
  /** The canvas's sticky notes, for `note` handoffs. Default: the hub's. */
  notes?: NoteStore;
  /** Where attached patches are kept. Without it, code can't be attached. */
  blobs?: BlobStore;
  /** Default SUMMARIZE_TIMEOUT_MS. */
  summarizeTimeoutMs?: number;
  now?: () => Date;
  newId?: () => string;
};

export type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string; needFolder?: boolean };

/** Ids: "h" + 10 base-36 characters. */
export function newHandoffId(): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  let id = "h";
  for (const byte of randomBytes(10)) id += alphabet[byte % 36];
  return id;
}

/** How long a draft waits on the summarizer before using the heuristic draft. */
export const SUMMARIZE_TIMEOUT_MS = 45_000;

/** `promise`, or undefined once `ms` pass. */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/**
 * Drafts, stores and routes handoffs where the hub runs (local daemon or team
 * server). It never acts on a checkout itself. The only things it asks of a
 * daemon are writing an accepted handoff's files (asked from a browser paired
 * to the receiving machine) and bundling a shared session's changes (asked
 * from a browser paired to the sending machine).
 */
export class HandoffService {
  readonly #now: () => Date;
  readonly #newId: () => string;
  /** Handoffs whose accept is waiting on the receiving daemon. */
  readonly #accepting = new Set<string>();

  constructor(readonly options: HandoffServiceOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? newHandoffId;
  }

  list(): Handoff[] {
    return this.options.store.list().map((r) => r.handoff);
  }

  get(id: string): Handoff | undefined {
    return this.options.store.get(id)?.handoff;
  }

  /** The editable preview for a drag. */
  async draft(
    req: HandoffDraftRequest,
    asker: Asker = { local: true },
  ): Promise<ServiceResult<HandoffDraft>> {
    const result = await this.#draft(req);
    if (!result.ok || req.kind === "note") return result;
    const canAttachCode = this.#canAttach(req.fromSessionId, asker);
    return { ok: true, value: { ...result.value, canAttachCode } };
  }

  async #draft(req: HandoffDraftRequest): Promise<ServiceResult<HandoffDraft>> {
    const note = this.#note(req);
    if (note && !note.ok) return note;
    const parties = this.#parties(req.fromSessionId, req.toSessionId, req.kind === "note");
    if (!parties.ok) return parties;
    const { from, to } = parties.value;
    const hub = this.options.hub;
    const events = hub.sessionEvents(req.fromSessionId);
    const filesTouched = hub.session(req.fromSessionId)?.files ?? [];
    const header = {
      sender: req.sender ?? from.user ?? "a teammate",
      from,
      to,
      at: this.#now().toISOString(),
    };
    const built = buildHandoffDraft(events, header, {
      kind: req.kind,
      eventId: req.eventId,
      filesTouched,
      note: note?.value,
    });
    if (!built.ok) return { ok: false, status: 404, error: built.error };
    if (built.kind !== "full" || !built.summary) {
      return {
        ok: true,
        value: { markdown: built.markdown, summarizer: "none" },
      };
    }
    const summarize = this.options.summarize;
    if (!summarize) {
      return {
        ok: true,
        value: {
          markdown: built.markdown,
          summary: built.summary,
          summarizer: "heuristic",
        },
      };
    }
    // Any failure or slowness (no Ollama, model error, bad reply) falls back to
    // the heuristic draft: the handoff never waits on the model for long.
    const reply = await withDeadline(
      summarize(summarizerInput(events)),
      this.options.summarizeTimeoutMs ?? SUMMARIZE_TIMEOUT_MS,
    ).catch((err: unknown) => {
      this.options.logger.warn({ err }, "handoff summarizer failed; using the heuristic draft");
      return undefined;
    });
    if (!reply) {
      return {
        ok: true,
        value: {
          markdown: built.markdown,
          summary: built.summary,
          summarizer: "heuristic",
          warning: "The summarizer wasn't available, so this draft comes from the transcript.",
        },
      };
    }
    const summary = withFiles(reply, filesTouched);
    return {
      ok: true,
      value: {
        markdown: renderHandoff(header, summary),
        summary,
        summarizer: "model",
      },
    };
  }

  /** Stores a handoff and sends it on its way. */
  async create(
    body: HandoffCreate,
    asker: Asker = { local: true },
  ): Promise<ServiceResult<Handoff>> {
    const note = this.#note(body);
    if (note && !note.ok) return note;
    const files = note?.value.files ?? [];
    const parties = this.#parties(body.fromSessionId, body.toSessionId, body.kind === "note");
    if (!parties.ok) return parties;
    const attach = body.attachCode === true && body.kind !== "note";
    if (attach && !this.#canAttach(body.fromSessionId, asker)) {
      return {
        ok: false,
        status: 403,
        error: "Only a browser paired with the sending machine can attach its code.",
      };
    }
    const { from, to } = parties.value;
    const route = this.options.route;
    const hub = this.options.hub;
    const fromDaemon = hub.sessionSource(body.fromSessionId);
    const toDaemon = hub.sessionSource(body.toSessionId);
    const code = attach ? await this.#bundle(fromDaemon, body.fromSessionId) : undefined;
    const at = this.#now().toISOString();
    const fromMachine = route.machineOf(fromDaemon);
    const toMachine = route.machineOf(toDaemon);
    const handoff: Handoff = {
      id: this.#newId(),
      kind: body.kind,
      status: "pending",
      sender: body.sender,
      from: { ...from, ...(fromDaemon === undefined ? {} : { daemon: fromDaemon }) },
      to: { ...to, ...(toDaemon === undefined ? {} : { daemon: toDaemon }) },
      markdown: body.markdown,
      ...(files.length > 0 ? { attachments: files.map((f) => ({ ...f })) } : {}),
      ...(code ? { code } : {}),
      createdAt: at,
      updatedAt: at,
    };
    const record: HandoffRecord = {
      handoff,
      ...(fromDaemon === undefined ? {} : { fromDaemon }),
      ...(toDaemon === undefined ? {} : { toDaemon }),
      ...(fromMachine === undefined ? {} : { fromMachine }),
      ...(toMachine === undefined ? {} : { toMachine }),
    };
    this.options.store.put(record);
    this.#announce(handoff);
    this.#offer(record);
    return { ok: true, value: handoff };
  }

  /** Asks the sending daemon for the session's changes and keeps the patch as a blob. */
  async #bundle(daemon: string | undefined, sessionId: string): Promise<HandoffCode> {
    const reply = await this.options.route.code(daemon, sessionId);
    if (!reply) {
      return { state: "unavailable", reason: "The sending machine didn't answer in time." };
    }
    if (reply.code.state !== "attached" || !reply.patch) {
      return { ...reply.code, state: "unavailable" };
    }
    const sha256 = await this.options.blobs?.put(reply.patch);
    if (sha256 === undefined) {
      return { state: "unavailable", reason: "The hub has no room for the patch." };
    }
    return { ...reply.code, state: "attached", sha256, bytes: reply.patch.length };
  }

  /** A handoff for its page, and whether this browser may answer it. */
  view(id: string, asker: Asker): HandoffView | undefined {
    const record = this.options.store.get(id);
    if (!record) return undefined;
    const may = this.#mayAnswer(record, asker);
    return {
      handoff: record.handoff,
      canAnswer: may.ok,
      ...(may.ok ? {} : { why: may.why }),
    };
  }

  /**
   * Accept, from a browser paired to the receiving machine: its daemon writes
   * the handoff into `folder` (or the receiving session's folder) and says
   * where. Nothing else happens on that machine.
   */
  async accept(
    id: string,
    folder: string | undefined,
    asker: Asker,
  ): Promise<ServiceResult<Handoff>> {
    const record = this.options.store.get(id);
    if (!record) return { ok: false, status: 404, error: "unknown handoff" };
    const may = this.#mayAnswer(record, asker);
    if (!may.ok) return { ok: false, status: 403, error: may.why };
    if (record.handoff.status !== "pending") {
      return {
        ok: false,
        status: 409,
        error: `This handoff was already ${record.handoff.status}.`,
      };
    }
    if (this.#accepting.has(id)) {
      return { ok: false, status: 409, error: "This handoff is already being accepted." };
    }
    this.#accepting.add(id);
    try {
      const result = await this.options.route.write(record.toDaemon, id, folder);
      if (!result) {
        return {
          ok: false,
          status: 409,
          error:
            "The receiving machine isn't connected. Run `baton start --server …` there and try again.",
        };
      }
      if (!result.ok) {
        return {
          ok: false,
          status: 409,
          error: result.error,
          ...(result.needFolder ? { needFolder: true } : {}),
        };
      }
      const current = this.options.store.get(id) ?? record;
      if (current.handoff.status !== "pending") {
        return {
          ok: false,
          status: 409,
          error: `This handoff was already ${current.handoff.status}.`,
        };
      }
      current.handoff = {
        ...current.handoff,
        status: "accepted",
        delivery: result.delivery,
        updatedAt: this.#now().toISOString(),
      };
      this.#settle(current);
      return { ok: true, value: current.handoff };
    } finally {
      this.#accepting.delete(id);
    }
  }

  /** Decline, from a browser paired to the receiving machine, with an optional note for the sender. */
  decline(id: string, note: string | undefined, asker: Asker): ServiceResult<Handoff> {
    const record = this.options.store.get(id);
    if (!record) return { ok: false, status: 404, error: "unknown handoff" };
    const may = this.#mayAnswer(record, asker);
    if (!may.ok) return { ok: false, status: 403, error: may.why };
    if (record.handoff.status !== "pending") {
      return {
        ok: false,
        status: 409,
        error: `This handoff was already ${record.handoff.status}.`,
      };
    }
    if (this.#accepting.has(id)) {
      return { ok: false, status: 409, error: "This handoff is being accepted." };
    }
    record.handoff = {
      ...record.handoff,
      status: "declined",
      ...(note ? { note } : {}),
      updatedAt: this.#now().toISOString(),
    };
    this.#settle(record);
    return { ok: true, value: record.handoff };
  }

  /** A daemon (re)connected: resend what it hasn't answered yet. */
  daemonConnected(daemon: string | undefined): void {
    for (const record of this.options.store.list().reverse()) {
      if (record.handoff.status !== "pending") continue;
      if (record.toDaemon === daemon) this.#offer(record);
    }
  }

  /** Saves an answered handoff, tells viewers, and lets the receiving daemon forget it. */
  #settle(record: HandoffRecord): void {
    this.options.store.put(record);
    this.#announce(record.handoff);
    this.#offer(record);
  }

  /**
   * Whether this browser answers for the receiving machine: on `baton start`
   * always; on a team server only when paired to the receiving daemon's name
   * and machine.
   */
  #mayAnswer(record: HandoffRecord, asker: Asker): { ok: true } | { ok: false; why: string } {
    if (asker.local) return { ok: true };
    const to = record.toDaemon;
    if (to === undefined) return { ok: false, why: "This handoff has no receiving machine." };
    return this.#pairedWith(asker.pairing, to, record.toMachine, "receiving");
  }

  /** Whether this browser speaks for the machine running `sessionId`. */
  #canAttach(sessionId: string, asker: Asker): boolean {
    if (!this.options.blobs) return false;
    if (asker.local) return true;
    const daemon = this.options.hub.sessionSource(sessionId);
    if (daemon === undefined) return false;
    return this.#pairedWith(asker.pairing, daemon, undefined, "sending").ok;
  }

  #pairedWith(
    pairing: Pairing | null,
    daemon: string,
    knownMachine: string | undefined,
    role: "sending" | "receiving",
  ): { ok: true } | { ok: false; why: string } {
    if (pairing === null) {
      return {
        ok: false,
        why: `Pair this browser with the ${role} machine (${daemon}) to answer.`,
      };
    }
    if (pairing.name !== daemon) {
      return {
        ok: false,
        why: `This browser is paired with ${pairing.name}; this handoff is for ${daemon}.`,
      };
    }
    const live = this.options.route.machineOf(daemon);
    const machine = knownMachine ?? live;
    if (machine === undefined) {
      return { ok: false, why: `${daemon} isn't connected, so its machine can't be checked.` };
    }
    if (pairing.machine !== machine || (live !== undefined && live !== machine)) {
      return {
        ok: false,
        why: `This browser is paired with a different machine named ${daemon}. Pair it again from the right one.`,
      };
    }
    return { ok: true };
  }

  #offer(record: HandoffRecord): void {
    this.options.route.offer(record.toDaemon, { type: "handoff_offer", handoff: record.handoff });
  }

  #announce(handoff: Handoff): void {
    this.options.hub.broadcast({ type: "handoff", handoff });
  }

  /** Files handoffs still need: pending handoffs' note files, and every patch (kept for its page). */
  attachmentsInUse(): Set<string> {
    const out = new Set<string>();
    for (const { handoff } of this.options.store.list()) {
      if (handoff.code?.sha256 !== undefined) out.add(handoff.code.sha256);
      if (handoff.status !== "pending") continue;
      for (const f of handoff.attachments ?? []) out.add(f.sha256);
    }
    return out;
  }

  /** A `note` handoff's note (undefined for other kinds). */
  #note(req: { kind: HandoffDraftRequest["kind"]; noteId?: string | undefined }) {
    if (req.kind !== "note") return undefined;
    const note = req.noteId === undefined ? undefined : this.#notes().get(req.noteId);
    if (!note) return { ok: false as const, status: 404, error: "that sticky note is gone" };
    return { ok: true as const, value: note };
  }

  #notes(): NoteStore {
    return this.options.notes ?? this.options.hub.notes;
  }

  /** A note comes from the canvas, not a session: its "from" is the receiver. */
  #parties(
    fromId: string,
    toId: string,
    sameIsFine = false,
  ): ServiceResult<{ from: HandoffParty; to: HandoffParty }> {
    if (fromId === toId && !sameIsFine)
      return { ok: false, status: 400, error: "pick a different session" };
    const from = this.#party(fromId);
    const to = this.#party(toId);
    if (!from || !to) return { ok: false, status: 404, error: "unknown session" };
    return { ok: true, value: { from, to } };
  }

  #party(sessionId: string): HandoffParty | undefined {
    const s = this.options.hub.session(sessionId);
    if (!s) return undefined;
    return {
      sessionId,
      ...(s.user === undefined ? {} : { user: s.user }),
      agent: s.agent,
      repoId: s.repo?.repoId ?? null,
      branch: s.repo?.branch ?? null,
    };
  }
}
