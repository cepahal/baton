import { access, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import Fastify, { LogController } from "fastify";
import type { Logger } from "pino";
import { codeReply } from "./code-bundle.js";
import { type DaemonConfig, HOST, type RemoteConfig } from "./config.js";
import { DiskQueue } from "./disk-queue.js";
import { type HandoffDeps, inboxOptions } from "./handoff-kit.js";
import { codeMessage, writtenReply } from "./handoff-replies.js";
import { registerInboxRedirect } from "./handoff-routes.js";
import { Inbox } from "./inbox.js";
import { logFilePath } from "./logging.js";
import { loadMachineId } from "./machine-id.js";
import { openUrl } from "./open-url.js";
import { type PairLink, requestPairLink } from "./pair-client.js";
import { httpBase, remoteBlobFetcher } from "./remote-blobs.js";
import { RemoteSink } from "./remote-sink.js";
import { RepoResolver } from "./repo-info.js";
import { RepoTaggingSink } from "./repo-sink.js";
import { registerReportRoute } from "./report-page.js";
import { isLocalRequest } from "./server.js";
import { SessionDirs } from "./session-dirs.js";
import { SharingPolicy, SharingSink } from "./sharing.js";
import { logSources } from "./sources.js";
import { StateStore } from "./state-store.js";
import { TranscriptWatcher } from "./watcher.js";

export type Forwarder = {
  sink: RemoteSink;
  inbox: Inbox;
  /** `http://127.0.0.1:<port>` of the local server (the report page). */
  localUrl: string;
  watcher: TranscriptWatcher;
  sharing: SharingPolicy;
  /** Stops watching, saves offsets, and disconnects. Unsent events stay queued on disk. */
  close(): Promise<void>;
};

/**
 * `baton start --server …`: the same watcher as the local daemon, delivering to
 * a team server through a RemoteSink instead of a local hub. Its local server,
 * on 127.0.0.1, has only the report page (and redirects old confirm links).
 *
 * Handoffs: the inbox notifies about offers for this machine's sessions; when a
 * paired browser accepts one, the server asks this daemon to write it, and the
 * daemon writes files into a folder and nothing else.
 */
export async function startForwarder(
  config: DaemonConfig,
  remote: RemoteConfig,
  logger: Logger,
  deps: HandoffDeps & {
    onRefused?: (message: string) => void;
    /**
     * Shows the first pairing link. Default: printed on an interactive
     * terminal (and opened in the browser), never logged.
     */
    onPairLink?: (link: PairLink) => void;
  } = {},
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
  let localPort = config.port;
  const hubOrigin = httpBase(remote.server);
  const inboxLogger = logger.child({ component: "inbox" });
  const resolver = new RepoResolver();
  const sharing = new SharingPolicy({
    file: sharingFile,
    repoOf: (dir) => resolver.resolve(dir),
    logger: logger.child({ component: "sharing" }),
  });
  let dirs: SessionDirs | undefined;
  const inbox = new Inbox({
    fetchBlob: remoteBlobFetcher(remote.server, remote.token),
    sessionDir: (sessionId) => dirs?.get(sessionId),
    ...inboxOptions(inboxLogger, deps),
    origin: () => hubOrigin,
  });
  const bundle = deps.code ?? ((dir: string | undefined) => codeReply(dir));
  /** A shared session's changes; never a session outside `baton share`d repos. */
  const sharedCode = async (sessionId: string) => {
    const dir = dirs?.get(sessionId);
    if (dir === undefined || !(await sharing.shared(dir))) {
      return {
        code: {
          state: "unavailable" as const,
          reason: "That session isn't in a shared repo on the sending machine.",
        },
      };
    }
    return bundle(dir);
  };
  const local = Fastify({
    loggerInstance: inboxLogger,
    logController: new LogController({ disableRequestLogging: true }),
  });
  local.addHook("onRequest", async (req, reply) => {
    if (!isLocalRequest(req.headers)) {
      return reply.code(403).send({ error: "Baton only accepts requests from this machine" });
    }
  });
  registerInboxRedirect(local, () => hubOrigin);
  registerReportRoute(local, {
    logFile: logFilePath(stateDir, "daemon"),
    secrets: [remote.token],
    facts: { mode: "team daemon", server: remote.server, name: remote.name },
  });
  await local.listen({ host: HOST, port: config.port });
  const address = local.server.address();
  localPort = typeof address === "object" && address ? address.port : config.port;

  let paired = false;
  const showPairLink =
    deps.onPairLink ??
    ((link: PairLink) => {
      // A code is a credential: only an interactive terminal sees it, and never the log.
      if (!process.stdout.isTTY) {
        logger.info("to answer handoffs from a browser, run `baton pair` and open its link");
        return;
      }
      process.stdout.write(
        `
Pair your browser with this machine to accept handoffs (link works once, for 10 minutes):
  ${link.url}

`,
      );
      void openUrl(link.url);
    });
  const sink: RemoteSink = new RemoteSink({
    server: remote.server,
    token: remote.token,
    name: remote.name,
    queue,
    logger: logger.child({ component: "remote" }),
    onHandoff: (message) => {
      if (message.type === "handoff_offer") {
        inbox.receive(message);
      } else if (message.type === "handoff_write") {
        void writtenReply(message, (id, folder) => inbox.write(id, folder)).then((reply) =>
          sink.sendControl(reply),
        );
      } else {
        void codeMessage(message, sharedCode).then((reply) => sink.sendControl(reply));
      }
    },
    onConnected: () => {
      if (paired) return;
      paired = true;
      void requestPairLink({
        server: remote.server,
        token: remote.token,
        name: remote.name,
        machine,
      }).then((result) => {
        if (result.ok) showPairLink(result.link);
        else logger.warn({ error: result.error }, "could not get a browser pairing link");
      });
    },
    machine,
    ...(deps.onRefused ? { onRefused: deps.onRefused } : {}),
  });
  sink.start();

  const shared = await sharing.current();
  if (shared.paused) logger.warn("sharing is paused: nothing is sent (`baton resume` to resume)");
  else if (shared.repos.length === 0 && shared.folders.length === 0) {
    logger.warn(
      "no repos are shared yet, so nothing is sent: run `baton share` in a repo to share it",
    );
  }
  dirs = new SessionDirs(new RepoTaggingSink(sink, resolver));
  const watcher = new TranscriptWatcher({
    sources: logSources({ "claude-code": config.projectsDir, codex: config.codexDir }),
    sink: new SharingSink(dirs, sharing, logger.child({ component: "sharing" })),
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
  return { sink, inbox, localUrl: `http://${HOST}:${localPort}`, watcher, sharing, close };
}

/** The sharing file sits next to the state file. */
export const sharingFilePath = (stateFile: string): string =>
  join(dirname(stateFile), "sharing.json");
