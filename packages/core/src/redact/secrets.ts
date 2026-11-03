import type { BatonEvent, JsonValue } from "../event.js";

/** What a masked secret is replaced with. */
export const SECRET_MASK = "[redacted]";

/** Whole-match secrets: the match itself is the secret. */
const WHOLE: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}/g,
  /\bgsk_[A-Za-z0-9]{20,}/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

/**
 * `NAME=value` / `NAME: value` where the name says it holds a secret. The name
 * stays so the reader still knows what was there. Values that are references
 * (`$VAR`, `${…}`, `process.env…`) are left alone.
 */
const ENV_ASSIGNMENT =
  /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY)[A-Z0-9_]*\s*[=:]\s*)(["']?)(?![$({<]|https?:|\[redacted\])([^\s"'`,;]{8,})\2/g;
/** Any-case keys (`"apiKey": "…"`, `password = '…'`), but only with a quoted value, so code like `token = next()` stays. */
const QUOTED_ASSIGNMENT =
  /((?:\b|["'])[A-Za-z0-9_-]*(?:secret|token|password|passwd|api_?key|private_?key|access_?key)[A-Za-z0-9_-]*["']?\s*[=:]\s*)(["'])(?![$({<]|https?:|\[redacted\])([^\s"'`]{8,})\2/gi;

/** `scheme://user:password@host`: the password goes. */
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]{3,})@/gi;

/** `Authorization: Bearer <token>` and `Bearer <token>` in curl lines. */
const BEARER = /\b(Bearer\s+)(?!\[redacted\])([A-Za-z0-9._~+/=-]{16,})/g;

/**
 * Masks things that look like credentials: provider API keys, private keys,
 * JWTs, bearer tokens, passwords in URLs, and `SECRET=…`-style assignments.
 * Pure and idempotent. A best-effort net, not a guarantee: see
 * docs/what-baton-shares.md.
 */
export function maskSecrets(text: string): string {
  if (text.length < 8) return text;
  let out = text;
  for (const re of WHOLE) out = out.replace(re, SECRET_MASK);
  out = out.replace(URL_PASSWORD, `$1${SECRET_MASK}@`);
  out = out.replace(BEARER, `$1${SECRET_MASK}`);
  const keepName = (_m: string, name: string, quote: string) =>
    `${name}${quote}${SECRET_MASK}${quote}`;
  out = out.replace(ENV_ASSIGNMENT, keepName);
  out = out.replace(QUOTED_ASSIGNMENT, keepName);
  return out;
}

/** Meta keys whose string values are identifiers or structure, never free text. */
const STRUCTURAL_KEYS = new Set([
  "id",
  "toolUseId",
  "parentId",
  "uuid",
  "ts",
  "kind",
  "type",
  "role",
]);

/** `maskSecrets` on every string in a JSON value, except under structural keys. */
export function maskSecretsDeep(value: JsonValue, key?: string): JsonValue {
  if (typeof value === "string") {
    return key !== undefined && STRUCTURAL_KEYS.has(key) ? value : maskSecrets(value);
  }
  if (Array.isArray(value)) return value.map((v) => maskSecretsDeep(v));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value)) out[k] = maskSecretsDeep(v, k);
    return out;
  }
  return value;
}

/**
 * An event with credentials masked in its text and meta. Ids, timestamps and
 * paths are untouched, so the event keeps its identity and still dedupes.
 */
export function maskEventSecrets(event: BatonEvent): BatonEvent {
  const text = maskSecrets(event.text);
  if (event.meta === undefined) return text === event.text ? event : { ...event, text };
  const meta: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries(event.meta)) meta[k] = maskSecretsDeep(v, k);
  return { ...event, text, meta };
}
