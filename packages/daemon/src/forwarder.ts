import { dirname } from "node:path";
import Fastify, { LogController } from "fastify";
import type { Logger } from "pino";
import { type DaemonConfig, HOST, type RemoteConfig } from "./config.js";
import { DiskQueue } from "./disk-queue.js";
import { type HandoffDeps, inboxOptions } from "./handoff-kit.js";
import { registerInboxRoutes } from "./handoff-routes.js";
import { Inbox } from "./inbox.js";
import { remoteBlobFetcher } from "./remote-blobs.js";
import { RemoteSink } from "./remote-sink.js";
import { RepoResolver } from "./repo-info.js";
import { RepoTaggingSink } from "./repo-sink.js";
import { isLocalRequest } from "./server.js";
import { logSources } from "./sources.js";
import { StateStore } from "./state-store.js";
import { TranscriptWatcher } from "./watcher.js";

export type Forwarder = {
  sink: RemoteSink;
  inbox: Inbox;
  /** `http://127.0.0.1:<port>` of the local confirm pages. */
  inboxUrl: string;
  watcher: TranscriptWatcher;
  /** Stops watching, saves offsets, and disconnects. Unsent events stay queued on disk. */
  close(): Promise<void>;
};

/**
 * `baton start --server …`: the same watcher as the local daemon, delivering to
 * a team server through a RemoteSink instead of a local hub. Its only local
 * server holds the handoff confirm pages, on 127.0.0.1.
 */
export async function startForwarder(
  config: DaemonConfig,
  remote: RemoteConfig,
  logger: Logger,
  deps: HandoffDeps = {},
): Promise<Forwarder> {
  const state = await StateStore.load(config.stateFile, logger.child({ component: "state" }));
  const queue = await DiskQueue.open({
    dir: remote.queueDir,
    maxBytes: remote.queueMb * 1024 * 1024,
    logger: logger.child({ component: "queue" }),
  });
  let inboxPort = config.port;
  let sink: RemoteSink | undefined;
  const inboxLogger = logger.child({ component: "inbox" });
  const inbox = new Inbox({
    ...inboxOptions(dirname(config.stateFile), inboxLogger, deps),
    fetchBlob: remoteBlobFetcher(remote.server, remote.token),
    origin: () => `http://${HOST}:${inboxPort}`,
    report: (message) => sink?.sendControl(message),
  });
  const local = Fastify({
    loggerInstance: inboxLogger,
    logController: new LogController({ disableRequestLogging: true }),
  });
  local.addHook("onRequest", async (req, reply) => {
    if (!isLocalRequest(req.headers)) {
      return reply.code(403).send({ error: "Baton only accepts requests from this machine" });
    }
  });
  registerInboxRoutes(local, inbox);
  await local.listen({ host: HOST, port: config.port });
  const address = local.server.address();
  inboxPort = typeof address === "object" && address ? address.port : config.port;

  sink = new RemoteSink({
    server: remote.server,
    token: remote.token,
    name: remote.name,
    queue,
    logger: logger.child({ component: "remote" }),
    onHandoff: (message) => inbox.receive(message),
  });
  sink.start();

  const watcher = new TranscriptWatcher({
    sources: logSources({ "claude-code": config.projectsDir, codex: config.codexDir }),
    sink: new RepoTaggingSink(sink, new RepoResolver()),
    state,
    logger: logger.child({ component: "watcher" }),
    backlogPerSession: config.backlog === "all" ? Number.POSITIVE_INFINITY : config.backlog,
    activeWindowMs: config.activeMinutes * 60_000,
    recentPerAgent: config.recent,
    poll: config.poll,
  });
  try {
    await watcher.start();
  } catch (err) {
    await sink.close();
    await local.close();
    throw err;
  }

  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= (async () => {
      // The queue stops waiting for space first, so a full queue can't hang shutdown.
      await queue.close();
      await watcher.close();
      await state.flush();
      await sink.close();
      await local.close();
    })();
    return closing;
  };
  return { sink, inbox, inboxUrl: `http://${HOST}:${inboxPort}`, watcher, close };
}
