import { stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { Logger } from "pino";
import { BlobStore } from "./blob-store.js";
import { CanvasStore } from "./canvas-store.js";
import { type DaemonConfig, HOST } from "./config.js";
import { MemoryEventLog } from "./event-log.js";
import { type HandoffDeps, localHandoffs } from "./handoff-kit.js";
import { Hub } from "./hub.js";
import { logFilePath } from "./logging.js";
import { modelsFor } from "./models.js";
import { NoteStore } from "./note-store.js";
import { RepoResolver } from "./repo-info.js";
import { RepoTaggingSink } from "./repo-sink.js";
import { createServer } from "./server.js";
import { logSources } from "./sources.js";
import { StateStore } from "./state-store.js";
import { TranscriptWatcher } from "./watcher.js";

export type Daemon = {
  hub: Hub;
  handoffs: Awaited<ReturnType<typeof localHandoffs>>;
  watcher: TranscriptWatcher;
  server: Awaited<ReturnType<typeof createServer>>;
  /** `http://127.0.0.1:<port>` */
  url: string;
  port: number;
  /** Stops watching, saves offsets, and closes every connection. */
  close(): Promise<void>;
};

/**
 * Starts the hub and server first, so viewers can connect, then the watcher,
 * which publishes the startup backlog into the hub.
 */
export async function startDaemon(
  config: DaemonConfig,
  logger: Logger,
  deps: HandoffDeps = {},
): Promise<Daemon> {
  const activeWindowMs = config.activeMinutes * 60_000;
  const state = await StateStore.load(config.stateFile, logger.child({ component: "state" }));
  const hubLogger = logger.child({ component: "hub" });
  // In memory for now: a restart starts a new epoch. A persistent EventLog
  // would let viewers resume across restarts (see docs/daemon.md).
  const log = new MemoryEventLog({
    maxBytes: config.bufferMb * 1024 * 1024,
    maxEvents: config.bufferSize,
    onEvict: (info) =>
      hubLogger.warn(
        { ...info, bufferMb: config.bufferMb },
        "event buffer full; dropping the oldest events (raise --buffer-mb to keep more)",
      ),
  });
  const { tieBreaker, summarize } = modelsFor(config, hubLogger);
  const canvas = new CanvasStore({
    file: join(dirname(config.stateFile), "canvas.json"),
    logger: hubLogger,
  });
  await canvas.load();
  const notes = new NoteStore({
    file: join(dirname(config.stateFile), "notes.json"),
    logger: hubLogger,
  });
  await notes.load();
  const blobs = new BlobStore({ dir: join(dirname(config.stateFile), "blobs"), logger: hubLogger });
  const hub = new Hub({
    log,
    activeWindowMs,
    logger: hubLogger,
    canvas,
    notes,
    ...userField(),
    ...(tieBreaker ? { tieBreaker } : {}),
  });
  let port = config.port;
  const handoffs = await localHandoffs({
    hub,
    dataDir: dirname(config.stateFile),
    logger: logger.child({ component: "handoffs" }),
    origin: () => `http://${HOST}:${port}`,
    summarize,
    deps,
    blobs,
  });
  const serverLogger = logger.child({ component: "server" });
  const webDir = await viewerDir(config.webDir, serverLogger);
  const server = await createServer(hub, serverLogger, {
    ...(webDir === undefined ? {} : { webDir }),
    handoffs: handoffs.service,
    notes: { blobs, blobsInUse: () => handoffs.service.attachmentsInUse() },
    report: {
      logFile: logFilePath(dirname(config.stateFile), "daemon"),
      secrets: [],
      facts: { mode: "local daemon" },
    },
  });
  await server.listen({ host: HOST, port: config.port });
  const address = server.server.address();
  port = typeof address === "object" && address ? address.port : config.port;

  const watcher = new TranscriptWatcher({
    sources: logSources({ "claude-code": config.projectsDir, codex: config.codexDir }),
    sink: new RepoTaggingSink(hub, new RepoResolver()),
    state,
    logger: logger.child({ component: "watcher" }),
    backlogPerSession: config.backlog === "all" ? Number.POSITIVE_INFINITY : config.backlog,
    activeWindowMs,
    recentPerAgent: config.recent,
    poll: config.poll,
  });
  try {
    await watcher.start();
  } catch (err) {
    await server.close();
    throw err;
  }

  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= (async () => {
      await watcher.close();
      // Stop taking requests first, so writes they make are in the flush.
      await server.close();
      await state.flush();
      await canvas.flush();
      await notes.flush();
      await handoffs.store.flush();
    })();
    return closing;
  };
  return { hub, handoffs, watcher, server, url: `http://${HOST}:${port}`, port, close };
}

/** `dir` if it holds a built viewer, otherwise undefined (with a warning). */
export async function viewerDir(dir: string, logger: Logger): Promise<string | undefined> {
  try {
    if ((await stat(join(dir, "index.html"))).isFile()) return dir;
  } catch {
    // fall through
  }
  logger.warn({ webDir: dir }, "no built viewer found; run `pnpm build` to serve it at /");
  return undefined;
}

const userField = (): { user?: string } => {
  const user = localUserName();
  return user === undefined ? {} : { user };
};

/** The OS user's name, or undefined when there isn't one (e.g. an arbitrary container uid). */
export function localUserName(): string | undefined {
  try {
    return userInfo().username || undefined;
  } catch {
    return undefined;
  }
}
