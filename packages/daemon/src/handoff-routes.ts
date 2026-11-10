import {
  HandoffAcceptRequest,
  type HandoffAnswerError,
  HandoffCreate,
  HandoffDeclineRequest,
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
import type { Asker, HandoffService } from "./handoff-service.js";

export type BatonApp = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  Logger
>;

export type HandoffRouteOptions = {
  /** Who is asking: the local browser, or a team browser and its pairing. */
  asker: (req: FastifyRequest) => Asker;
  /** Sends the viewer's page, for a browser opening `/handoffs/:id`. */
  page?: (reply: FastifyReply) => FastifyReply | Promise<FastifyReply>;
};

const IdParams = z.object({ id: HandoffId });

/** Whether a GET is a browser navigating to a page rather than the viewer fetching JSON. */
export function wantsPage(req: FastifyRequest): boolean {
  const accept = req.headers.accept ?? "";
  return accept.includes("text/html");
}

/**
 * `/handoffs`: drafting, sending, listing, and answering, wherever the hub
 * runs. Accept and decline act only for a browser that answers for the
 * receiving machine (see `HandoffService`); the server checks, not the page.
 */
export function registerHandoffRoutes(
  app: BatonApp,
  service: HandoffService,
  options: HandoffRouteOptions,
): void {
  app.get("/handoffs", async (): Promise<HandoffsResponse> => ({ handoffs: service.list() }));

  app.post("/handoffs/draft", async (req, reply) => {
    const body = HandoffDraftRequest.safeParse(req.body);
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: "body must be { kind, fromSessionId, toSessionId, eventId?, sender? }" });
    }
    const result = await service.draft(body.data, options.asker(req));
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
    const result = await service.create(body.data, options.asker(req));
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    const response: HandoffResponse = { handoff: result.value };
    return reply.code(201).send(response);
  });

  app.get("/handoffs/:id", async (req, reply) => {
    if (wantsPage(req) && options.page) return options.page(noStore(reply));
    const params = IdParams.safeParse(req.params);
    const view = params.success ? service.view(params.data.id, options.asker(req)) : undefined;
    if (!view) return reply.code(404).send({ error: "unknown handoff" });
    return noStore(reply).send(view);
  });

  app.post("/handoffs/:id/accept", async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    const body = HandoffAcceptRequest.safeParse(req.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "body must be { folder? }" });
    }
    const result = await service.accept(params.data.id, body.data.folder, options.asker(req));
    if (!result.ok) {
      const error: HandoffAnswerError = {
        error: result.error,
        ...(result.needFolder ? { needFolder: true } : {}),
      };
      return reply.code(result.status).send(error);
    }
    const response: HandoffResponse = { handoff: result.value };
    return response;
  });

  app.post("/handoffs/:id/decline", async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    const body = HandoffDeclineRequest.safeParse(req.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "body must be { note? }" });
    }
    const note = body.data.note === "" ? undefined : body.data.note;
    const result = service.decline(params.data.id, note, options.asker(req));
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    const response: HandoffResponse = { handoff: result.value };
    return response;
  });
}

/**
 * The old localhost confirm page, `/inbox/:id`, now just points at the
 * handoff's page where the hub runs (old notifications still link here).
 */
export function registerInboxRedirect(app: BatonApp, hubOrigin: () => string): void {
  app.get("/inbox/:id", async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    if (!params.success) return reply.code(404).type("text/plain").send("No such handoff.\n");
    return reply.redirect(`${hubOrigin()}/handoffs/${params.data.id}`, 302);
  });
}

function noStore(reply: FastifyReply): FastifyReply {
  return reply.header("cache-control", "no-store");
}
