import { type MeResponse, PairClaimRequest, type PairCodeResponse, PairRequest } from "@baton/core";
import type { FastifyReply, FastifyRequest } from "fastify";
import { bearerToken, readCookie, secretsMatch } from "./auth.js";
import type { BatonApp } from "./handoff-routes.js";
import { PAIR_COOKIE, type PairingStore, pairCookieHeader } from "./pairing-store.js";

export type PairingRouteOptions = {
  pairings: PairingStore;
  /** The team token: only daemons (bearer) may ask for codes. */
  token: string;
  /** Whether `name` is connected right now from `machine`: a daemon may only pair its own machine. */
  connected: (name: string, machine: string) => boolean;
  /** Sends the viewer's page, for a browser opening `/pair`. */
  page?: (reply: FastifyReply) => FastifyReply | Promise<FastifyReply>;
};

/** The machine this browser is paired with, from its cookie. */
export function pairingOf(req: FastifyRequest, pairings: PairingStore) {
  return pairings.lookup(readCookie(req.headers.cookie, PAIR_COOKIE));
}

/**
 * Pairing a browser with a machine (team server only). Codes are never logged:
 * they travel in a POST body and in the pairing link's fragment, which
 * browsers don't send to servers.
 */
export function registerPairingRoutes(app: BatonApp, options: PairingRouteOptions): void {
  const { pairings } = options;

  app.get("/me", async (req, reply): Promise<MeResponse> => {
    reply.header("cache-control", "no-store");
    return { local: false, pairing: pairingOf(req, pairings) };
  });

  app.post("/pair", async (req, reply) => {
    const bearer = bearerToken(req.headers.authorization);
    if (bearer === undefined || !secretsMatch(bearer, options.token)) {
      return reply.code(403).send({ error: "only a daemon can ask for a pairing code" });
    }
    const body = PairRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "body must be { name, machine }" });
    if (!options.connected(body.data.name, body.data.machine)) {
      return reply
        .code(409)
        .send({ error: "connect this daemon to the server first, then ask for a pairing code" });
    }
    const { code, expiresAt } = pairings.newCode(body.data);
    const response: PairCodeResponse = { code, expiresAt: new Date(expiresAt).toISOString() };
    return reply.header("cache-control", "no-store").send(response);
  });

  app.post("/pair/claim", async (req, reply) => {
    const body = PairClaimRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "body must be { code }" });
    const previous = readCookie(req.headers.cookie, PAIR_COOKIE);
    const claimed = pairings.claim(body.data.code, previous);
    if (!claimed) {
      return reply.code(410).send({
        error:
          "This pairing link was already used or has expired. Run `baton pair` on your machine for a new one.",
      });
    }
    const secure = req.protocol === "https";
    reply.header("set-cookie", pairCookieHeader(claimed.id, secure));
    const response: MeResponse = { local: false, pairing: claimed.pairing };
    return response;
  });

  if (options.page) {
    const page = options.page;
    app.get("/pair", async (_req, reply) => page(reply.header("cache-control", "no-store")));
  }
}

/** `baton start`: the only browser is this machine's own, so it needs no pairing. */
export function registerLocalMe(app: BatonApp): void {
  app.get("/me", async (): Promise<MeResponse> => ({ local: true, pairing: null }));
}
