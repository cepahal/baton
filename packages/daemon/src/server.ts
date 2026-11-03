import {
  CanvasMoveBody,
  type CanvasResponse,
  DomainOverrideBody,
  EventsQuery,
  type EventsResponse,
  IngestClientMessage,
  IngestQuery,
  type IngestServerMessage,
  type SessionsResponse,
  SubscribeQuery,
} from "@baton/core";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  LogController,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault,
} from "fastify";
import type { Logger } from "pino";
import { z } from "zod";
import {
  bearerToken,
  isAuthorized,
  isSameOrigin,
  secretsMatch,
  sessionCookieHeader,
} from "./auth.js";
import type { IngestRoute } from "./handoff-route.js";
import { registerHandoffRoutes, registerInboxRoutes } from "./handoff-routes.js";
import type { HandoffRoute, HandoffService } from "./handoff-service.js";
import type { Hub } from "./hub.js";
import type { Inbox } from "./inbox.js";
import { LOGIN_PAGE } from "./login-page.js";

/** Close code for a request the server refuses (RFC 6455 "policy violation"). */
const CLOSE_POLICY = 1008;
const MAX_CLIENT_MESSAGE_BYTES = 64 * 1024;
/** Largest `/ingest` message (one batch of events) a team server accepts. */
export const MAX_INGEST_MESSAGE_BYTES = 16 * 1024 * 1024;
/** A daemon connection that misses a ping for this long is closed. */
const INGEST_PING_MS = 15_000;

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

/**
 * Who may connect. `local` (`baton start`): this machine only, no auth.
 * `team` (`baton serve`): anyone with the team token, which daemons send as a
 * bearer token and browsers exchange for a cookie at `/login`.
 */
export type Access = { kind: "local" } | { kind: "team"; token: string };

export type ServerOptions = {
  /** Directory of the built viewer, served at `/`. Without it `/` explains how to build it. */
  webDir?: string;
  /** Default `local`. */
  access?: Access;
  /** Drafting, storing and routing handoffs (`/handoffs`). */
  handoffs?: HandoffService;
  /** Team server: where `/ingest` connections register so handoffs reach their daemon. */
  ingestRoute?: IngestRoute;
  /** This machine's handoff inbox (`/inbox`). Never on a team server. */
  inbox?: Inbox;
};

export type { HandoffRoute };

/** Paths a team server answers without a token. */
const PUBLIC_PATHS = new Set(["/login", "/health"]);
/** Paths that answer with data (401 when unauthorized) rather than pages (redirect to login). */
const API_PATHS = new Set(["/sessions", "/events", "/ws", "/ingest", "/handoffs", "/canvas"]);

const LoginBody = z.object({ token: z.string().min(1).max(1024) });

const NO_VIEWER =
  "Baton is running, but the viewer isn't built. Run `pnpm build`, then restart `baton start`.\n";

export async function createServer(hub: Hub, logger: Logger, options: ServerOptions = {}) {
  const app = Fastify({
    loggerInstance: logger,
    logController: new LogController({ disableRequestLogging: true }),
  });

  const access = options.access ?? { kind: "local" };
  const team = access.kind === "team" ? access : undefined;

  // Registered before the access checks: the plugin's own onRequest hook must see
  // upgrade requests first, or a refused upgrade leaves its socket open.
  await app.register(websocket, {
    options: { maxPayload: team ? MAX_INGEST_MESSAGE_BYTES : MAX_CLIENT_MESSAGE_BYTES },
  });

  if (team) {
    app.addHook("onRequest", async (req, reply) => {
      const url = new URL(req.url, "http://baton.invalid");
      if (!isSameOrigin(req.headers)) {
        logger.warn(
          { host: req.headers.host, origin: req.headers.origin },
          "refused cross-origin request",
        );
        return reply.code(403).send({ error: "cross-origin requests are not allowed" });
      }
      if (PUBLIC_PATHS.has(url.pathname)) return;
      // `/?token=…` signs a browser in, so a link can be shared.
      const linkToken = url.searchParams.get("token");
      if (req.method === "GET" && url.pathname === "/" && linkToken !== null) {
        if (!secretsMatch(linkToken, team.token)) return reply.redirect("/login");
        return reply.header("set-cookie", sessionCookieHeader(team.token)).redirect("/");
      }
      const daemonOnly = url.pathname === "/ingest";
      const authorized =
        isAuthorized(req.headers, team.token) &&
        (!daemonOnly || bearerToken(req.headers.authorization) !== undefined);
      if (authorized) return;
      if (req.method === "GET" && !API_PATHS.has(url.pathname) && !req.headers.upgrade) {
        return reply.redirect("/login");
      }
      return reply.code(401).send({ error: "missing or wrong team token" });
    });

    app.get("/login", async (_req, reply) => reply.type("text/html").send(LOGIN_PAGE));
    app.post("/login", async (req, reply) => {
      const body = LoginBody.safeParse(req.body);
      if (!body.success || !secretsMatch(body.data.token, team.token)) {
        return reply.code(401).send({ error: "wrong token" });
      }
      return reply.header("set-cookie", sessionCookieHeader(team.token)).send({ ok: true });
    });

    registerIngest(app, hub, logger, options);
  } else
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
      const text = data.toString();
      if (Buffer.byteLength(text) > MAX_CLIENT_MESSAGE_BYTES) {
        socket.close(CLOSE_POLICY, "message too large");
        return;
      }
      hub.receive(client, text);
    });
    socket.on("close", () => {
      hub.disconnect(client);
      logger.info("viewer disconnected");
    });
  });

  app.get("/sessions", async (): Promise<SessionsResponse> => ({ sessions: hub.sessions() }));

  // Pin a session's domain label by hand; `{ "label": null }` goes back to automatic.
  app.put<{ Params: { sessionId: string } }>("/sessions/:sessionId/domain", async (req, reply) => {
    const body = DomainOverrideBody.safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: "body must be { label: <domain> | null }" });
    if (!hub.setDomainOverride(req.params.sessionId, body.data.label)) {
      return reply.code(404).send({ error: "unknown session" });
    }
    const session = hub.sessions().find((s) => s.sessionId === req.params.sessionId);
    return session?.domain ?? { label: body.data.label };
  });

  // The shared canvas: which session cards are on it, and where.
  app.get("/canvas", async (): Promise<CanvasResponse> => ({ positions: hub.canvasPositions() }));
  app.put("/canvas/positions", async (req, reply) => {
    const body = CanvasMoveBody.safeParse(req.body);
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: "body must be { positions: { <key>: { x, y } }, removed?: [<key>] }" });
    }
    hub.moveCanvasNodes(body.data.positions, body.data.removed ?? []);
    return reply.code(204).send();
  });

  app.get("/events", async (req, reply): Promise<EventsResponse | undefined> => {
    const query = EventsQuery.safeParse(req.query);
    if (!query.success) {
      await reply.code(400).send({ error: "invalid query: use ?after=&limit=" });
      return undefined;
    }
    return hub.entries(query.data.after, query.data.limit);
  });

  app.get("/health", async () => ({ ok: true, epoch: hub.epoch, seq: hub.seq }));

  if (options.handoffs) registerHandoffRoutes(app, options.handoffs);
  // Confirm pages act on this machine, so a server reachable from elsewhere never has them.
  if (options.inbox && !team) registerInboxRoutes(app, options.inbox);

  if (options.webDir === undefined) {
    app.get("/", async (_req, reply) => reply.type("text/plain").send(NO_VIEWER));
  } else {
    // Registered last; the routes above are more specific and win.
    await app.register(fastifyStatic, { root: options.webDir, prefix: "/" });
  }

  return app;
}

type TeamApp = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  Logger
>;

/** `/ingest`: daemons push batches of events; each is acked once the hub holds it. */
function registerIngest(app: TeamApp, hub: Hub, logger: Logger, options: ServerOptions): void {
  app.get("/ingest", { websocket: true }, (socket, req) => {
    const query = IngestQuery.safeParse(req.query);
    if (!query.success) {
      send(socket, { type: "error", message: "invalid query: use ?name=<daemon name>" });
      socket.close(CLOSE_POLICY, "invalid query");
      return;
    }
    const source = query.data.name;
    const log = logger.child({ daemon: source });
    log.info("daemon connected");

    let alive = true;
    const ping = setInterval(() => {
      if (!alive) {
        log.warn("daemon stopped answering pings");
        socket.terminate();
        return;
      }
      alive = false;
      socket.ping();
    }, INGEST_PING_MS);
    socket.on("pong", () => {
      alive = true;
    });
    options.ingestRoute?.attach(source, socket);
    options.handoffs?.daemonConnected(source);

    socket.on("message", (data, isBinary) => {
      alive = true;
      const msg = isBinary ? undefined : parseIngest(data.toString());
      if (!msg) {
        send(socket, { type: "error", message: "invalid publish message" });
        socket.close(CLOSE_POLICY, "invalid message");
        return;
      }
      if (msg.type === "handoff_status") {
        // Answers about handoffs; the service checks this daemon is the one asked.
        options.handoffs?.fromDaemon(source, msg);
        return;
      }
      const accepted = hub.accept(msg.events, {
        ...(msg.backlog ? { backlog: true } : {}),
        ...(msg.repos ? { repos: msg.repos } : {}),
        source,
      });
      send(socket, { type: "ack", batch: msg.batch, accepted });
    });
    socket.on("close", () => {
      clearInterval(ping);
      options.ingestRoute?.detach(source, socket);
      log.info("daemon disconnected");
    });
  });
}

function parseIngest(text: string): IngestClientMessage | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const msg = IngestClientMessage.safeParse(json);
  return msg.success ? msg.data : undefined;
}

function send(socket: { send(data: string): void }, msg: IngestServerMessage): void {
  socket.send(JSON.stringify(msg));
}
