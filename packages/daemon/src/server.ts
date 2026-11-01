import { type SessionsResponse, SubscribeQuery } from "@baton/core";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyRequest, LogController } from "fastify";
import type { Logger } from "pino";
import type { Hub } from "./hub.js";

/** Close code for a request the server refuses (RFC 6455 "policy violation"). */
const CLOSE_POLICY = 1008;
const MAX_CLIENT_MESSAGE_BYTES = 64 * 1024;

const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Hostname of a `Host` header or origin URL, or undefined if it can't be parsed. */
function hostnameOf(value: string, isOrigin: boolean): string | undefined {
  try {
    return new URL(isOrigin ? value : `http://${value}`).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Only local pages may talk to the daemon. The Host check stops DNS rebinding;
 * the Origin check stops other websites from opening a WebSocket (browsers
 * don't apply CORS to WebSockets). Clients that send no Origin, like wscat, are
 * allowed.
 */
export function isLocalRequest(headers: FastifyRequest["headers"]): boolean {
  const host = headers.host;
  if (host === undefined || !LOCAL_HOSTNAMES.has(hostnameOf(host, false) ?? "")) return false;
  const origin = headers.origin;
  return origin === undefined || LOCAL_HOSTNAMES.has(hostnameOf(origin, true) ?? "");
}

export async function createServer(hub: Hub, logger: Logger) {
  const app = Fastify({
    loggerInstance: logger,
    logController: new LogController({ disableRequestLogging: true }),
  });

  // Registered before the Origin check: the plugin's own onRequest hook must see
  // upgrade requests first, or a refused upgrade leaves its socket open.
  await app.register(websocket, { options: { maxPayload: MAX_CLIENT_MESSAGE_BYTES } });

  app.addHook("onRequest", async (req, reply) => {
    if (!isLocalRequest(req.headers)) {
      logger.warn(
        { host: req.headers.host, origin: req.headers.origin },
        "refused non-local request",
      );
      return reply.code(403).send({ error: "Baton only accepts requests from this machine" });
    }
    // The viewer runs on its own localhost port, so let local origins read responses.
    if (req.headers.origin) reply.header("access-control-allow-origin", req.headers.origin);
  });

  app.get("/ws", { websocket: true }, (socket, req) => {
    const query = SubscribeQuery.safeParse(req.query);
    if (!query.success) {
      socket.send(
        JSON.stringify({ type: "error", message: "invalid query: use ?session=&lastSeq=&epoch=" }),
      );
      socket.close(CLOSE_POLICY, "invalid query");
      return;
    }
    const client = hub.connect(socket, query.data);
    logger.info({ session: query.data.session, lastSeq: query.data.lastSeq }, "viewer connected");
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      hub.receive(client, data.toString());
    });
    socket.on("close", () => {
      hub.disconnect(client);
      logger.info("viewer disconnected");
    });
  });

  app.get("/sessions", async (): Promise<SessionsResponse> => ({ sessions: hub.sessions() }));

  app.get("/health", async () => ({ ok: true, epoch: hub.epoch, seq: hub.seq }));

  return app;
}
