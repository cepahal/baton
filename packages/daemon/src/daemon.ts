import type { Logger } from "pino";
import { type DaemonConfig, HOST } from "./config.js";
import { MemoryEventLog } from "./event-log.js";
import { Hub } from "./hub.js";
import { createServer } from "./server.js";
import { StateStore } from "./state-store.js";
import { TranscriptWatcher } from "./watcher.js";

export type Daemon = {
  hub: Hub;
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
export async function startDaemon(config: DaemonConfig, logger: Logger): Promise<Daemon> {
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
  const hub = new Hub({ log, activeWindowMs, logger: hubLogger });
  const server = await createServer(hub, logger.child({ component: "server" }));
  await server.listen({ host: HOST, port: config.port });
  const address = server.server.address();
  const port = typeof address === "object" && address ? address.port : config.port;

  const watcher = new TranscriptWatcher({
    projectsDir: config.projectsDir,
    sink: hub,
    state,
    logger: logger.child({ component: "watcher" }),
    backlogPerSession: config.backlog === "all" ? Number.POSITIVE_INFINITY : config.backlog,
    activeWindowMs,
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
      await state.flush();
      await server.close();
    })();
    return closing;
  };
  return { hub, watcher, server, url: `http://${HOST}:${port}`, port, close };
}
