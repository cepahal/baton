import type { Logger } from "pino";
import type { ServeConfig } from "./config.js";
import { viewerDir } from "./daemon.js";
import { MemoryEventLog } from "./event-log.js";
import { Hub } from "./hub.js";
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
export async function startTeamServer(config: ServeConfig, logger: Logger): Promise<TeamServer> {
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
  const hub = new Hub({ log, activeWindowMs: config.activeMinutes * 60_000, logger: hubLogger });
  const serverLogger = logger.child({ component: "server" });
  const webDir = await viewerDir(config.webDir, serverLogger);
  const server = await createServer(hub, serverLogger, {
    ...(webDir === undefined ? {} : { webDir }),
    access: { kind: "team", token: config.token },
  });
  await server.listen({ host: config.host, port: config.port });
  const address = server.server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  const host = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
  return { hub, server, url: `http://${host}:${port}`, port, close: () => server.close() };
}
