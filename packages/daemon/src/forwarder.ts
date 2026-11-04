import { access, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import Fastify, { LogController } from "fastify";
import type { Logger } from "pino";
import { type DaemonConfig, HOST, type RemoteConfig } from "./config.js";
import { DiskQueue } from "./disk-queue.js";
import { type HandoffDeps, inboxOptions } from "./handoff-kit.js";
import { registerInboxRoutes } from "./handoff-routes.js";
import { Inbox } from "./inbox.js";
import { logFilePath } from "./logging.js";
import { loadMachineId } from "./machine-id.js";
import { remoteBlobFetcher } from "./remote-blobs.js";
import { RemoteSink } from "./remote-sink.js";
import { RepoResolver } from "./repo-info.js";
import { RepoTaggingSink } from "./repo-sink.js";
import { registerReportRoute } from "./report-page.js";
import { isLocalRequest } from "./server.js";
import { SharingPolicy, SharingSink } from "./sharing.js";
import { logSources } from "./sources.js";
import { StateStore } from "./state-store.js";
import { TranscriptWatcher } from "./watcher.js";

export type Forwarder = {
  sink: RemoteSink;
  inbox: Inbox;
  /** `http://127.0.0.1:<port>` of the local confirm pages. */
  inboxUrl: string;
  watcher: TranscriptWatcher;
  sharing: SharingPolicy;
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
  deps: HandoffDeps & { onRefused?: (message: string) => void } = {},
): Promise<Forwarder> {
  const stateDir = dirname(config.stateFile);
  const sharingFile = sharingFilePath(config.stateFile);
  const state = await StateStore.load(config.stateFile, logger.child({ component: "state" }));
  const queue = await DiskQueue.open({
    dir: remote.queueDir,
    maxBytes: remote.queueMb * 1024 * 1024,
    logger: logger.child({ component: "queue" }),
  });
  // Marks a queue whose events all went through SharingSink. Without it, the
  // queue is from a Baton before sharing controls, when everything was sent:
  // none of it was chosen, so none of it goes. (Keyed on the queue itself, not
  // sharing.json, which `baton share` can create before the daemon restarts.)
  const filteredMarker = join(remote.queueDir, "sharing-filtered");
  const filtered = await access(filteredMarker).then(
    () => true,
    () => false,
  );
  if (!filtered) {
    if (queue.size > 0) {
      logger.warn(
        { events: queue.size },
        "dropping events queued by an older Baton before sharing controls existed",
      );
      await queue.ack(queue.size);
    }
    await writeFile(filteredMarker, "");
  }
  const machine = await loadMachineId(join(stateDir, "machine-id"));
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
  registerReportRoute(local, {
    logFile: logFilePath(stateDir, "daemon"),
    secrets: [remote.token],
    facts: { mode: "team daemon", server: remote.server, name: remote.name },
  });
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
    machine,
    ...(deps.onRefused ? { onRefused: deps.onRefused } : {}),
  });
  sink.start();

  const resolver = new RepoResolver();
  const sharing = new SharingPolicy({
    file: sharingFile,
    repoOf: (dir) => resolver.resolve(dir),
    logger: logger.child({ component: "sharing" }),
  });
  const shared = await sharing.current();
  if (shared.paused) logger.warn("sharing is paused: nothing is sent (`baton resume` to resume)");
  else if (shared.repos.length === 0 && shared.folders.length === 0) {
    logger.warn(
      "no repos are shared yet, so nothing is sent: run `baton share` in a repo to share it",
    );
  }
  const watcher = new TranscriptWatcher({
    sources: logSources({ "claude-code": config.projectsDir, codex: config.codexDir }),
    sink: new SharingSink(
      new RepoTaggingSink(sink, resolver),
      sharing,
      logger.child({ component: "sharing" }),
    ),
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
  return { sink, inbox, inboxUrl: `http://${HOST}:${inboxPort}`, watcher, sharing, close };
}

/** The sharing file sits next to the state file. */
export const sharingFilePath = (stateFile: string): string =>
  join(dirname(stateFile), "sharing.json");
