import { maskSecrets } from "../redact/secrets.js";

/** What replaces a private key's lines in a patch. */
export const REDACTED_LINE = "[redacted private key]";

const KEY_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const KEY_END = /-----END [A-Z ]*PRIVATE KEY-----/;

/** Files whose names alone mark them as secrets; they never go into a patch. */
const SECRET_FILE_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\..*)?$/i,
  /\.(pem|key|p12|pfx)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)credentials[^/]*$/i,
];

/** True for a repo-relative path that must never be shared. */
export function isSecretPath(path: string): boolean {
  const p = path.replace(/\\/g, "/");
  return SECRET_FILE_PATTERNS.some((r) => r.test(p));
}

/**
 * Masks credentials on the added (`+`) lines of a git patch, with the same
 * rules as the live feed. Only line contents change, never the number of
 * lines, so hunk headers stay right and the patch still applies. Binary hunks
 * are left alone. Returns the files that changed.
 */
export function redactPatch(patch: string): { patch: string; redacted: string[] } {
  const redacted = new Set<string>();
  let file = "";
  let inKey = false;
  let binary = false;
  const lines = patch.split("\n").map((line) => {
    const header = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
    if (header) {
      file = header[2] ?? "";
      inKey = false;
      binary = false;
      return line;
    }
    if (line.startsWith("GIT binary patch")) binary = true;
    if (binary || !line.startsWith("+") || line.startsWith("+++ ")) return line;
    const body = line.slice(1);
    let next: string;
    if (inKey || KEY_BEGIN.test(body)) {
      inKey = !KEY_END.test(body);
      next = REDACTED_LINE;
    } else {
      next = maskSecrets(body);
    }
    if (next === body) return line;
    redacted.add(file);
    return `+${next}`;
  });
  return { patch: lines.join("\n"), redacted: [...redacted] };
}

/**
 * Paths a patch would write, or an error if any is unsafe: absolute, with a
 * `..` segment, or inside `.git`.
 */
export function patchPaths(patch: string): { paths: string[] } | { error: string } {
  const paths = new Set<string>();
  for (const line of patch.split("\n")) {
    const m =
      /^diff --git a\/(.*) b\/(.*)$/.exec(line) ??
      /^(?:rename|copy) (?:from|to) (.*)$/.exec(line) ??
      /^(?:---|\+\+\+) [ab]\/(.*)$/.exec(line);
    if (!m) continue;
    for (const raw of m.slice(1)) {
      if (raw === undefined) continue;
      const p = raw.replace(/\\/g, "/");
      const segments = p.split("/");
      if (
        p.startsWith("/") ||
        /^[a-z]:/i.test(p) ||
        segments.includes("..") ||
        segments.some((s) => s.toLowerCase() === ".git")
      ) {
        return { error: `the patch touches an unsafe path: ${p}` };
      }
      paths.add(p);
    }
  }
  return { paths: [...paths] };
}
