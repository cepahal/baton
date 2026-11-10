import { createHash, randomBytes } from "node:crypto";
import { PAIRING_CODE_TTL_MS, Pairing } from "@baton/core";
import type { Logger } from "pino";
import { z } from "zod";
import {
  loadVersioned,
  parseRecords,
  saveVersioned,
  type VersionedSpec,
} from "./versioned-file.js";

/** Cookie that binds a browser to one machine. Its value is a random id; the server keeps only its hash. */
export const PAIR_COOKIE = "baton_pair";

/** Pairings kept; beyond it the oldest go. */
export const MAX_PAIRINGS = 1000;
/** Unclaimed codes kept at once; beyond it the oldest go. */
const MAX_CODES = 1000;

const hash = (secret: string): string => createHash("sha256").update(secret).digest("hex");

/** A paired browser: the hash of its cookie id, and the machine it speaks for. */
export const PairingRecord = Pairing.extend({
  idHash: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.iso.datetime({ offset: true }),
});
export type PairingRecord = z.infer<typeof PairingRecord>;

export const PAIRINGS_FILE: VersionedSpec<PairingRecord[]> = {
  what: "browser pairings",
  version: 1,
  // Version 0 would be a bare array, the same records without the envelope.
  migrations: [(data) => data],
  parse: parseRecords(PairingRecord, MAX_PAIRINGS),
};

/** `Set-Cookie` value for a paired browser. */
export function pairCookieHeader(id: string, secure: boolean): string {
  return `${PAIR_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${secure ? "; Secure" : ""}`;
}

/**
 * Browser ↔ machine pairings on a team server. A daemon asks for a one-time
 * code; a logged-in browser that presents it gets a cookie binding it to that
 * daemon's name and machine id. Codes are single-use, expire after
 * `PAIRING_CODE_TTL_MS`, and are kept (like cookie ids) only as hashes, so
 * neither a log nor the state file holds one.
 */
export class PairingStore {
  readonly #codes = new Map<string, { pairing: Pairing; expiresAt: number }>();
  readonly #pairings = new Map<string, PairingRecord>();
  #saving: Promise<void> = Promise.resolve();

  constructor(readonly options: { file?: string; logger?: Logger; now?: () => number } = {}) {}

  async load(): Promise<void> {
    const file = this.options.file;
    if (file === undefined) return;
    const records = await loadVersioned(file, PAIRINGS_FILE, this.options.logger);
    for (const r of records ?? []) this.#pairings.set(r.idHash, r);
  }

  /** A fresh code for `pairing`. */
  newCode(pairing: Pairing): { code: string; expiresAt: number } {
    this.#sweep();
    const code = randomBytes(32).toString("base64url");
    const expiresAt = this.#now() + PAIRING_CODE_TTL_MS;
    this.#codes.set(hash(code), {
      pairing: { name: pairing.name, machine: pairing.machine },
      expiresAt,
    });
    while (this.#codes.size > MAX_CODES) {
      const oldest = this.#codes.keys().next().value;
      if (oldest === undefined) break;
      this.#codes.delete(oldest);
    }
    return { code, expiresAt };
  }

  /**
   * Uses up a code. Returns the new cookie id and its pairing, or undefined
   * when the code is unknown, used or expired. `previous` (the browser's old
   * cookie id) is forgotten: a browser is paired with one machine at a time.
   */
  claim(code: string, previous?: string): { id: string; pairing: Pairing } | undefined {
    const key = hash(code);
    const entry = this.#codes.get(key);
    this.#codes.delete(key);
    if (!entry || entry.expiresAt <= this.#now()) return undefined;
    if (previous !== undefined) this.#pairings.delete(hash(previous));
    const id = randomBytes(32).toString("base64url");
    const record: PairingRecord = {
      ...entry.pairing,
      idHash: hash(id),
      createdAt: new Date(this.#now()).toISOString(),
    };
    this.#pairings.set(record.idHash, record);
    while (this.#pairings.size > MAX_PAIRINGS) {
      const oldest = this.#pairings.keys().next().value;
      if (oldest === undefined) break;
      this.#pairings.delete(oldest);
    }
    this.#save();
    return { id, pairing: entry.pairing };
  }

  /** The machine a browser's cookie id is paired with, or null. */
  lookup(id: string | undefined): Pairing | null {
    if (id === undefined || id === "") return null;
    const r = this.#pairings.get(hash(id));
    return r ? { name: r.name, machine: r.machine } : null;
  }

  /** Unpairs a browser. */
  forget(id: string): void {
    if (this.#pairings.delete(hash(id))) this.#save();
  }

  async flush(): Promise<void> {
    await this.#saving;
  }

  #sweep(): void {
    const now = this.#now();
    for (const [key, entry] of this.#codes) if (entry.expiresAt <= now) this.#codes.delete(key);
  }

  #now(): number {
    return (this.options.now ?? Date.now)();
  }

  #save(): void {
    const file = this.options.file;
    if (file === undefined) return;
    const data = [...this.#pairings.values()];
    this.#saving = this.#saving.then(async () => {
      try {
        await saveVersioned(file, PAIRINGS_FILE.version, data);
      } catch (err) {
        this.options.logger?.warn({ err, file }, "could not save browser pairings");
      }
    });
  }
}
