import type { Logger } from "pino";
import { startBackups } from "./backup.js";
import { BlobStore } from "./blob-store.js";
import { CanvasStore } from "./canvas-store.js";
import type { ServeConfig } from "./config.js";
import { viewerDir } from "./daemon.js";
import { MemoryEventLog } from "./event-log.js";
import { IngestRoute } from "./handoff-route.js";
import { HandoffService } from "./handoff-service.js";
import { HandoffStore } from "./handoff-store.js";
import { Hub } from "./hub.js";
import { modelsFor } from "./models.js";
import { NoteStore } from "./note-store.js";
import { PairingStore } from "./pairing-store.js";
import { RemovedSessions } from "./removed-sessions.js";
import { createServer } from "./server.js";

export type TeamServer = {
  hub: Hub;
  server: Awaited<ReturnType<typeof createServer>>;
  /** `http://<host>:<port>` as bound. */
  url: string;
  port: number;
  close(): Promise<void>;
};

/**
 * `baton serve`: a hub fed by remote daemons over `/ingest` instead of a local
 * watcher, plus the viewer, on every interface and behind the team token.
 */
export async function startTeamServer(
  config: ServeConfig,
  logger: Logger,
  options: {
    canvasFile?: string;
    handoffsFile?: string;
    /** Which browsers are paired with which machines. */
    pairingsFile?: string;
    notesFile?: string;
    blobsDir?: string;
    /** Sessions removed from the canvas, so their daemons' resends are dropped. */
    removedFile?: string;
    /** Where nightly snapshots go. Without it, no backups. */
    backupDir?: string;
  } = {},
): Promise<TeamServer> {
  const hubLogger = logger.child({ component: "hub" });
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
    ...(options.canvasFile === undefined ? {} : { file: options.canvasFile }),
    logger: hubLogger,
  });
  await canvas.load();
  const notes = new NoteStore({
    ...(options.notesFile === undefined ? {} : { file: options.notesFile }),
    logger: hubLogger,
  });
  await notes.load();
  const blobs = new BlobStore({
    ...(options.blobsDir === undefined ? {} : { dir: options.blobsDir }),
    logger: hubLogger,
  });
  const removed = new RemovedSessions({
    ...(options.removedFile === undefined ? {} : { file: options.removedFile }),
    logger: hubLogger,
  });
  await removed.load();
  const hub = new Hub({
    notes,
    removed,
    log,
    activeWindowMs: config.activeMinutes * 60_000,
    logger: hubLogger,
    canvas,
    ...(tieBreaker ? { tieBreaker } : {}),
  });
  const handoffLogger = logger.child({ component: "handoffs" });
  const store = new HandoffStore({
    ...(options.handoffsFile === undefined ? {} : { file: options.handoffsFile }),
    logger: handoffLogger,
  });
  await store.load();
  const pairings = new PairingStore({
    ...(options.pairingsFile === undefined ? {} : { file: options.pairingsFile }),
    logger: handoffLogger,
  });
  await pairings.load();
  const ingestRoute = new IngestRoute();
  const handoffs = new HandoffService({
    hub,
    store,
    route: ingestRoute,
    logger: handoffLogger,
    summarize,
    blobs,
  });
  const serverLogger = logger.child({ component: "server" });
  const webDir = await viewerDir(config.webDir, serverLogger);
  const server = await createServer(hub, serverLogger, {
    ...(webDir === undefined ? {} : { webDir }),
    access: { kind: "team", token: config.token },
    handoffs,
    ingestRoute,
    pairings,
    notes: { blobs, blobsInUse: () => handoffs.attachmentsInUse() },
  });
  await server.listen({ host: config.host, port: config.port });
  const files = [
    options.canvasFile,
    options.handoffsFile,
    options.notesFile,
    options.removedFile,
    options.pairingsFile,
  ];
  const backups =
    options.backupDir === undefined || options.blobsDir === undefined
      ? undefined
      : startBackups({
          files: files.filter((f): f is string => f !== undefined),
          blobsDir: options.blobsDir,
          backupDir: options.backupDir,
          logger: logger.child({ component: "backup" }),
          flush: async () => {
            await canvas.flush();
            await notes.flush();
            await store.flush();
            await removed.flush();
            await pairings.flush();
          },
        });
  const address = server.server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  const host = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
  return {
    hub,
    server,
    url: `http://${host}:${port}`,
    port,
    close: async () => {
      backups?.stop();
      await backups?.ready;
      await server.close();
      await canvas.flush();
      await notes.flush();
      await store.flush();
      await removed.flush();
      await pairings.flush();
    },
  };
}
