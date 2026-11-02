import type { Logger } from "pino";
import type { DaemonConfig, RemoteConfig } from "./config.js";
import { DiskQueue } from "./disk-queue.js";
import { RemoteSink } from "./remote-sink.js";
import { logSources } from "./sources.js";
import { StateStore } from "./state-store.js";
import { TranscriptWatcher } from "./watcher.js";

export type Forwarder = {
  sink: RemoteSink;
  watcher: TranscriptWatcher;
  /** Stops watching, saves offsets, and disconnects. Unsent events stay queued on disk. */
  close(): Promise<void>;
};

/**
 * `baton start --server …`: the same watcher as the local daemon, delivering to
 * a team server through a RemoteSink instead of a local hub. No local server.
 */
export async function startForwarder(
  config: DaemonConfig,
  remote: RemoteConfig,
  logger: Logger,
): Promise<Forwarder> {
  const state = await StateStore.load(config.stateFile, logger.child({ component: "state" }));
  const queue = await DiskQueue.open({
    dir: remote.queueDir,
    maxBytes: remote.queueMb * 1024 * 1024,
    logger: logger.child({ component: "queue" }),
  });
  const sink = new RemoteSink({
    server: remote.server,
    token: remote.token,
    name: remote.name,
    queue,
    logger: logger.child({ component: "remote" }),
  });
  sink.start();

  const watcher = new TranscriptWatcher({
    sources: logSources({ "claude-code": config.projectsDir, codex: config.codexDir }),
    sink,
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
    })();
    return closing;
  };
  return { sink, watcher, close };
}
