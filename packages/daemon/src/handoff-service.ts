import { randomBytes } from "node:crypto";
import {
  buildHandoffDraft,
  type Handoff,
  type HandoffCreate,
  type HandoffDraft,
  type HandoffDraftRequest,
  type HandoffOfferMessage,
  type HandoffParty,
  type HandoffStatusMessage,
  renderHandoff,
  summarizerInput,
  withFiles,
} from "@baton/core";
import type { Logger } from "pino";
import type { HandoffRecord, HandoffStore } from "./handoff-store.js";
import type { Hub } from "./hub.js";
import type { Summarizer } from "./summarizer.js";

/**
 * How handoff messages reach daemons. `daemon` is the session's daemon name on
 * a team server and undefined locally. Returns false when it isn't connected;
 * the service resends when it connects.
 */
export interface HandoffRoute {
  offer(daemon: string | undefined, message: HandoffOfferMessage): boolean;
}

export type HandoffServiceOptions = {
  hub: Hub;
  store: HandoffStore;
  route: HandoffRoute;
  logger: Logger;
  summarize?: Summarizer | undefined;
  /** Default SUMMARIZE_TIMEOUT_MS. */
  summarizeTimeoutMs?: number;
  now?: () => Date;
  newId?: () => string;
};

export type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string };

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
 * server). It never acts on a checkout: it only sends offers to the receiving
 * daemon, which acts after its user confirms on a localhost page.
 */
export class HandoffService {
  readonly #now: () => Date;
  readonly #newId: () => string;

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
  async draft(req: HandoffDraftRequest): Promise<ServiceResult<HandoffDraft>> {
    const parties = this.#parties(req.fromSessionId, req.toSessionId);
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
  async create(body: HandoffCreate): Promise<ServiceResult<Handoff>> {
    const parties = this.#parties(body.fromSessionId, body.toSessionId);
    if (!parties.ok) return parties;
    const { from, to } = parties.value;
    const hub = this.options.hub;
    const at = this.#now().toISOString();
    const handoff: Handoff = {
      id: this.#newId(),
      kind: body.kind,
      status: "pending",
      sender: body.sender,
      from,
      to,
      markdown: body.markdown,
      createdAt: at,
      updatedAt: at,
    };
    const fromDaemon = hub.sessionSource(body.fromSessionId);
    const toDaemon = hub.sessionSource(body.toSessionId);
    const record: HandoffRecord = {
      handoff,
      ...(fromDaemon === undefined ? {} : { fromDaemon }),
      ...(toDaemon === undefined ? {} : { toDaemon }),
    };
    this.options.store.put(record);
    this.#announce(handoff);
    this.#offer(record);
    return { ok: true, value: handoff };
  }

  /** A daemon (re)connected: resend what it hasn't answered yet. */
  daemonConnected(daemon: string | undefined): void {
    for (const record of this.options.store.list().reverse()) {
      if (record.handoff.status !== "pending") continue;
      if (record.toDaemon === daemon) this.#offer(record);
    }
  }

  /**
   * A receiving daemon's answer. `daemon` is who sent it (undefined locally).
   * Only the receiving session's daemon may answer, and only once.
   */
  fromDaemon(daemon: string | undefined, message: HandoffStatusMessage): void {
    const record = this.options.store.get(message.id);
    if (!record) return;
    if (record.toDaemon !== daemon) {
      this.options.logger.warn(
        { id: message.id, daemon },
        "ignoring a handoff answer from the wrong daemon",
      );
      return;
    }
    if (record.handoff.status !== "pending") return;
    record.handoff = {
      ...record.handoff,
      status: message.status,
      updatedAt: this.#now().toISOString(),
    };
    this.options.store.put(record);
    this.#announce(record.handoff);
  }

  #offer(record: HandoffRecord): void {
    const dir = this.options.hub.session(record.handoff.to.sessionId)?.projectPath;
    this.options.route.offer(record.toDaemon, {
      type: "handoff_offer",
      handoff: record.handoff,
      ...(dir ? { dir } : {}),
    });
  }

  #announce(handoff: Handoff): void {
    this.options.hub.broadcast({ type: "handoff", handoff });
  }

  #parties(fromId: string, toId: string): ServiceResult<{ from: HandoffParty; to: HandoffParty }> {
    if (fromId === toId) return { ok: false, status: 400, error: "pick a different session" };
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
