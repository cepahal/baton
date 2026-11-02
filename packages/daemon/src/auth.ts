import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";

/** Cookie a browser viewer gets after logging in to a team server. */
export const SESSION_COOKIE = "baton_session";

const sha256 = (value: string): Buffer => createHash("sha256").update(value).digest();

/** Constant-time comparison (hashing first makes the lengths equal). */
export function secretsMatch(given: string, expected: string): boolean {
  return timingSafeEqual(sha256(given), sha256(expected));
}

/**
 * Value of the viewer cookie for a team token. Derived rather than the token
 * itself, so the cookie can't be replayed as a daemon's bearer token.
 */
export function sessionCookieValue(token: string): string {
  return createHmac("sha256", token).update("baton viewer session v1").digest("hex");
}

/** `Set-Cookie` header value for a logged-in viewer. */
export function sessionCookieHeader(token: string): string {
  return `${SESSION_COOKIE}=${sessionCookieValue(token)}; HttpOnly; SameSite=Strict; Path=/`;
}

/** One cookie from a `Cookie` header, or undefined. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** Token from an `Authorization: Bearer <token>` header, or undefined. */
export function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return match?.[1];
}

/** Whether a request carries the team token (daemons) or a valid viewer cookie (browsers). */
export function isAuthorized(headers: FastifyRequest["headers"], token: string): boolean {
  const bearer = bearerToken(headers.authorization);
  if (bearer !== undefined) return secretsMatch(bearer, token);
  const cookie = readCookie(headers.cookie, SESSION_COOKIE);
  return cookie !== undefined && secretsMatch(cookie, sessionCookieValue(token));
}

/**
 * A browser request must come from the server's own pages: browsers send
 * cookies on cross-site WebSocket handshakes and don't apply CORS to them, so
 * without this another website could read the feed with a viewer's cookie.
 * Clients that send no Origin (daemons, curl) are allowed.
 */
export function isSameOrigin(headers: FastifyRequest["headers"]): boolean {
  const { origin, host } = headers;
  if (origin === undefined) return true;
  if (host === undefined) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
