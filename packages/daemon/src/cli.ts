import { parseArgs } from "node:util";
import { pino } from "pino";
import { z } from "zod";
import { type DaemonConfig, DEFAULT_BUFFER_MB, DEFAULT_PORT, resolveConfig } from "./config.js";
import { startDaemon } from "./daemon.js";

export const USAGE = `Usage: baton start [options]

Watches Claude Code transcripts and streams them on ws://127.0.0.1:<port>/ws.

Options:
  --port <n>            Port to listen on (default ${DEFAULT_PORT})
  --projects-dir <dir>  Transcript directory (default ~/.claude/projects)
  --state-file <file>   Where read offsets are saved
  --backlog <n|all>     History events sent per session (default all)
  --buffer-mb <n>       Memory for events kept for viewers (default ${DEFAULT_BUFFER_MB})
  --buffer-size <n>     Also cap the number of events kept (default no cap)
  --active-minutes <n>  How recent a change makes a session active (default 120)
  --poll                Poll files instead of using native file events
  --log-level <level>   fatal|error|warn|info|debug|trace|silent (default info)
  --web-dir <dir>       Built viewer to serve at / (default apps/web/dist)
  -h, --help            Show this help
`;

export type CliResult =
  | { command: "help" }
  | { command: "start"; config: DaemonConfig }
  | { command: "error"; message: string };

/** Parses `baton` arguments (without the node and script paths). Never throws. */
export function parseCli(argv: readonly string[]): CliResult {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (err) {
    return { command: "error", message: (err as Error).message };
  }
  const { values, positionals } = parsed;
  if (values.help) return { command: "help" };
  const [command, ...rest] = positionals;
  if (command !== "start") {
    return {
      command: "error",
      message: command ? `unknown command: ${command}` : "missing command",
    };
  }
  if (rest.length > 0) return { command: "error", message: `unexpected argument: ${rest[0]}` };

  try {
    const config = resolveConfig({
      port: values.port,
      projectsDir: values["projects-dir"],
      stateFile: values["state-file"],
      backlog: values.backlog,
      bufferMb: values["buffer-mb"],
      bufferSize: values["buffer-size"],
      activeMinutes: values["active-minutes"],
      poll: values.poll,
      logLevel: values["log-level"],
      webDir: values["web-dir"],
    });
    return { command: "start", config };
  } catch (err) {
    if (!(err instanceof z.ZodError)) throw err;
    const issue = err.issues[0];
    return { command: "error", message: `--${flagName(issue?.path[0])}: ${issue?.message}` };
  }
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      port: { type: "string" },
      "projects-dir": { type: "string" },
      "state-file": { type: "string" },
      backlog: { type: "string" },
      "buffer-mb": { type: "string" },
      "buffer-size": { type: "string" },
      "active-minutes": { type: "string" },
      poll: { type: "boolean" },
      "log-level": { type: "string" },
      "web-dir": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
}

/** `bufferSize` → `buffer-size`. */
const flagName = (key: PropertyKey | undefined) =>
  String(key ?? "").replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** Runs the CLI; resolves once the daemon has started (it then runs until a signal). */
export async function main(argv: readonly string[]): Promise<void> {
  const result = parseCli(argv);
  if (result.command === "help") {
    process.stdout.write(USAGE);
    return;
  }
  if (result.command === "error") {
    process.stderr.write(`baton: ${result.message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  const { config } = result;
  const logger = pino({ level: config.logLevel });
  let daemon: Awaited<ReturnType<typeof startDaemon>>;
  try {
    daemon = await startDaemon(config, logger);
  } catch (err) {
    logger.fatal({ err }, "baton could not start");
    process.exitCode = 1;
    return;
  }
  logger.info(
    {
      viewer: `${daemon.url}/`,
      ws: `${daemon.url.replace("http", "ws")}/ws`,
      sessions: `${daemon.url}/sessions`,
    },
    `baton is running: open ${daemon.url}/`,
  );

  const stop = (signal: NodeJS.Signals) => {
    logger.info({ signal }, "shutting down");
    daemon.close().then(
      () => process.exit(0),
      (err: unknown) => {
        logger.error({ err }, "error while shutting down");
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
