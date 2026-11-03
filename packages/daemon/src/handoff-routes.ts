import {
  HandoffCreate,
  HandoffDraftRequest,
  HandoffId,
  type HandoffResponse,
  type HandoffsResponse,
} from "@baton/core";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";
import type { Logger } from "pino";
import { z } from "zod";
import type { HandoffService } from "./handoff-service.js";
import type { ActionResult, Inbox } from "./inbox.js";
import { inboxPage, PAGE_CSP } from "./inbox-page.js";
import { isLocalRequest } from "./server.js";

type BatonApp = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  Logger
>;

/** `/handoffs`: drafting, sending and listing. Wherever the hub runs. */
export function registerHandoffRoutes(app: BatonApp, service: HandoffService): void {
  app.get("/handoffs", async (): Promise<HandoffsResponse> => ({ handoffs: service.list() }));

  app.post("/handoffs/draft", async (req, reply) => {
    const body = HandoffDraftRequest.safeParse(req.body);
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: "body must be { kind, fromSessionId, toSessionId, eventId?, sender? }" });
    }
    const result = await service.draft(body.data);
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return result.value;
  });

  app.post("/handoffs", async (req, reply) => {
    const body = HandoffCreate.safeParse(req.body);
    if (!body.success) {
      const issue = body.error.issues[0];
      return reply.code(400).send({
        error: `invalid handoff: ${issue?.path.join(".") ?? ""} ${issue?.message ?? ""}`.trim(),
      });
    }
    const result = await service.create(body.data);
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    const response: HandoffResponse = { handoff: result.value };
    return reply.code(201).send(response);
  });
}

const Token = z.object({ token: z.string().min(1).max(256) });
const AcceptBody = Token.extend({ folder: z.string().min(1).max(4096).optional() });
const IdParams = z.object({ id: HandoffId });

/**
 * Confirm requests must come from the confirm page itself: a local Host and an
 * Origin equal to it. With the per-handoff token, that keeps out the team
 * server, other websites and the viewer alike.
 */
export function isConfirmPageRequest(headers: FastifyRequest["headers"]): boolean {
  const { host, origin } = headers;
  if (!isLocalRequest(headers) || host === undefined || origin === undefined) return false;
  return origin === `http://${host}`;
}

/**
 * The machine-local side: `/inbox`, handoffs for this machine's sessions. Only
 * on a server that listens on 127.0.0.1.
 */
export function registerInboxRoutes(app: BatonApp, inbox: Inbox): void {
  app.get("/inbox", async () => ({ offers: inbox.list() }));

  app.get("/inbox/:id", async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    const offer = params.success ? inbox.offer(params.data.id) : undefined;
    if (!offer)
      return reply.code(404).type("text/plain").send("No such handoff on this machine.\n");
    const checkout = await inbox.checkoutFor(offer);
    return page(reply).send(inboxPage(offer, checkout));
  });

  const action = <S extends z.ZodType>(
    path: string,
    schema: S,
    run: (id: string, body: z.infer<S>) => Promise<ActionResult<object>>,
  ) => {
    app.post(path, async (req, reply) => {
      if (!isConfirmPageRequest(req.headers)) {
        return reply.code(403).send({ error: "only the confirm page on this machine can do that" });
      }
      const params = IdParams.safeParse(req.params);
      const body = schema.safeParse(req.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: "bad request" });
      const result = await run(params.data.id, body.data);
      if (!result.ok) {
        const { ok: _ok, status, ...rest } = result;
        return reply.code(status).send(rest);
      }
      return result;
    });
  };

  action("/inbox/:id/accept", AcceptBody, (id, b) => inbox.accept(id, b.token, b.folder));
  action("/inbox/:id/decline", Token, (id, b) => inbox.decline(id, b.token));
  action("/inbox/:id/start", Token, (id, b) => inbox.start(id, b.token));
}

function page(reply: FastifyReply): FastifyReply {
  return reply
    .type("text/html")
    .header("content-security-policy", PAGE_CSP)
    .header("x-frame-options", "DENY")
    .header("cache-control", "no-store");
}
