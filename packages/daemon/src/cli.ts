import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { type Logger, pino } from "pino";
import { z } from "zod";
import {
  type DaemonConfig,
  DEFAULT_BUFFER_MB,
  DEFAULT_PORT,
  DEFAULT_QUEUE_MB,
  DEFAULT_RECENT,
  DEFAULT_SUMMARIZER_MODEL,
  defaultStateFile,
  MIN_TOKEN_LENGTH,
  resolveConfig,
  resolveServeConfig,
  type ServeConfig,
} from "./config.js";
import { startDaemon } from "./daemon.js";
import { startForwarder } from "./forwarder.js";
import { DEFAULT_OLLAMA_URL } from "./ollama.js";
import { type ReplayOptions, runReplay } from "./replay.js";
import { startTeamServer } from "./team-server.js";

export const USAGE = `Usage:
  baton start [options]           Stream this machine's sessions (locally, or to a team server)
  baton serve [options]           Run a team server: hub + viewer for several daemons
  baton replay <fixture> [options]  Write a Claude Code or Codex log into a watched dir at its recorded pace

baton start: watches Claude Code and Codex sessions and serves them on
http://127.0.0.1:<port>, or with --server sends them to a team server.
  --port <n>            Port to listen on (default ${DEFAULT_PORT})
  --projects-dir <dir>  Claude Code transcripts (default ~/.claude/projects)
  --codex-dir <dir>     Codex session logs (default ~/.codex/sessions)
  --state-file <file>   Where read offsets are saved
  --backlog <n|all>     History events sent per session (default all)
  --buffer-mb <n>       Memory for events kept for viewers (default ${DEFAULT_BUFFER_MB})
  --buffer-size <n>     Also cap the number of events kept (default no cap)
  --active-minutes <n>  How recent a change makes a session active (default 120)
  --recent <n>          Also show each agent's n most recent sessions, however old (default ${DEFAULT_RECENT})
  --poll                Poll files instead of using native file events
  --web-dir <dir>       Built viewer to serve at / (default apps/web/dist)
  --server <url>        Team server (ws://host:port); the token comes from BATON_TOKEN
  --name <name>         Name teammates see for this machine (default OS username)
  --queue-dir <dir>     On-disk queue for events not yet sent (default next to the state file)
  --queue-mb <n>        Disk budget for that queue (default ${DEFAULT_QUEUE_MB})

baton serve: listens on 0.0.0.0. Daemons and browsers need the team token in
BATON_TOKEN (at least ${MIN_TOKEN_LENGTH} characters).
  --host <addr>         Address to bind (default 0.0.0.0)
  --port <n>            Port (default ${DEFAULT_PORT})
  --buffer-mb, --buffer-size, --web-dir   As for start
  --active-minutes <n>  How recently a session must have sent events to be listed (default 1440)

Environment (start and serve):
  BATON_SUMMARIZER=ollama|anthropic|off
                                   Model that drafts handoff summaries and settles
                                   a session's domain when the rules are unsure.
                                   ollama (default) uses a local Ollama and sends
                                   nothing off the machine; anthropic uses
                                   ANTHROPIC_API_KEY; off uses no model.
  BATON_SUMMARIZER_MODEL=<id>      Model to use (ollama: the fastest installed
                                   model; anthropic: ${DEFAULT_SUMMARIZER_MODEL})
  BATON_OLLAMA_URL=<url>           Where Ollama listens (default ${DEFAULT_OLLAMA_URL})

baton replay <fixture>: a Claude Code transcript or a Codex rollout (detected from its contents)
  --projects-dir <dir>  Claude Code projects directory a daemon is watching (for Claude Code fixtures)
  --codex-dir <dir>     Codex sessions directory a daemon is watching (for Codex fixtures)
  --speed <n>|<n>x      Play n times faster than recorded, e.g. 1x or 10x (default 1x)
  --as <name>           Simulated user: username in paths, and the run's label (default replay)
  --cwd <dir>           Play the session as if it ran in <dir> (replaces its recorded working directory)
  --max-gap <seconds>   Cut longer pauses (after scaling) to this
  --seed <text>         Derive the new UUIDs from this, for a reproducible run

Common:
  --log-level <level>   fatal|error|warn|info|debug|trace|silent (default info)
  -h, --help            Show this help
`;

export type ReplayCommand = Omit<ReplayOptions, "logger" | "signal" | "now" | "sleep"> & {
  logLevel: DaemonConfig["logLevel"];
};

export type CliResult =
  | { command: "help" }
  | { command: "start"; config: DaemonConfig }
  | { command: "serve"; config: ServeConfig }
  | { command: "replay"; options: ReplayCommand }
  | { command: "error"; message: string };

/** Environment variables the CLI reads, validated like the flags. */
const Env = z.object({
  BATON_TOKEN: z.string().min(1).optional(),
  BATON_SUMMARIZER: z.string().min(1).optional(),
  BATON_SUMMARIZER_MODEL: z.string().min(1).optional(),
  BATON_OLLAMA_URL: z.string().min(1).optional(),
});

const ReplayArgs = z.object({
  fixture: z.string().min(1),
  projectsDir: z.string().min(1).optional(),
  codexDir: z.string().min(1).optional(),
  speed: z
    .string()
    .regex(/^\d+(\.\d+)?x?$/i, "a number like 1, 10 or 10x")
    .transform((v) => Number(v.replace(/x$/i, "")))
    .pipe(z.number().positive())
    .default(1),
  as: z.string().min(1).default("replay"),
  cwd: z.string().min(1).optional(),
  maxGap: z.coerce.number().positive().optional(),
  seed: z.string().min(1).optional(),
  logLevel: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

/** Parses `baton` arguments (without the node and script paths). Never throws. */
export function parseCli(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): CliResult {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (err) {
    return { command: "error", message: (err as Error).message };
  }
  const { values, positionals } = parsed;
  if (values.help) return { command: "help" };
  const [command, ...rest] = positionals;
  const vars = Env.safeParse(env).data;
  const token = vars?.BATON_TOKEN;
  const summarizer = {
    summarizer: vars?.BATON_SUMMARIZER,
    summarizerModel: vars?.BATON_SUMMARIZER_MODEL,
    ollamaUrl: vars?.BATON_OLLAMA_URL,
  };

  try {
    switch (command) {
      case "start": {
        if (rest.length > 0) return unexpected(rest[0]);
        const misplaced = firstSet(values, ["host", "speed", "as", "cwd", "max-gap", "seed"]);
        if (misplaced) return { command: "error", message: `--${misplaced} isn't a start option` };
        const remoteOnly = firstSet(values, ["name", "queue-dir", "queue-mb"]);
        if (values.server === undefined && remoteOnly) {
          return { command: "error", message: `--${remoteOnly} needs --server` };
        }
        if (values.server !== undefined && token === undefined) {
          return { command: "error", message: "--server needs the team token in BATON_TOKEN" };
        }
        const config = resolveConfig({
          port: values.port,
          projectsDir: values["projects-dir"],
          codexDir: values["codex-dir"],
          stateFile: values["state-file"],
          backlog: values.backlog,
          bufferMb: values["buffer-mb"],
          bufferSize: values["buffer-size"],
          activeMinutes: values["active-minutes"],
          recent: values.recent,
          poll: values.poll,
          logLevel: values["log-level"],
          webDir: values["web-dir"],
          ...summarizer,
          remote:
            values.server === undefined
              ? undefined
              : {
                  server: values.server,
                  token,
                  name: values.name,
                  queueDir: values["queue-dir"],
                  queueMb: values["queue-mb"],
                },
        });
        return { command: "start", config };
      }
      case "serve": {
        if (rest.length > 0) return unexpected(rest[0]);
        const misplaced = firstSet(values, [
          "projects-dir",
          "codex-dir",
          "state-file",
          "backlog",
          "poll",
          "server",
          "name",
          "queue-dir",
          "queue-mb",
          "speed",
          "as",
          "max-gap",
          "seed",
        ]);
        if (misplaced) return { command: "error", message: `--${misplaced} isn't a serve option` };
        if (token === undefined) {
          return { command: "error", message: "serve needs the team token in BATON_TOKEN" };
        }
        const config = resolveServeConfig({
          host: values.host,
          port: values.port,
          token,
          bufferMb: values["buffer-mb"],
          bufferSize: values["buffer-size"],
          activeMinutes: values["active-minutes"],
          logLevel: values["log-level"],
          webDir: values["web-dir"],
          ...summarizer,
        });
        return { command: "serve", config };
      }
      case "replay": {
        const [fixture, ...extra] = rest;
        if (fixture === undefined) return { command: "error", message: "replay needs a fixture" };
        if (extra.length > 0) return unexpected(extra[0]);
        if (values["projects-dir"] === undefined && values["codex-dir"] === undefined) {
          return { command: "error", message: "replay needs --projects-dir or --codex-dir" };
        }
        const args = ReplayArgs.parse({
          fixture,
          projectsDir: values["projects-dir"],
          codexDir: values["codex-dir"],
          speed: values.speed,
          as: values.as,
          cwd: values.cwd,
          maxGap: values["max-gap"],
          seed: values.seed,
          logLevel: values["log-level"],
        });
        return {
          command: "replay",
          options: {
            fixture: args.fixture,
            ...(args.projectsDir === undefined ? {} : { projectsDir: args.projectsDir }),
            ...(args.codexDir === undefined ? {} : { codexDir: args.codexDir }),
            speed: args.speed,
            as: args.as,
            ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
            logLevel: args.logLevel,
            ...(args.maxGap === undefined ? {} : { maxGapMs: args.maxGap * 1000 }),
            ...(args.seed === undefined ? {} : { seed: args.seed }),
          },
        };
      }
      default:
        return {
          command: "error",
          message: command ? `unknown command: ${command}` : "missing command",
        };
    }
  } catch (err) {
    if (!(err instanceof z.ZodError)) throw err;
    const issue = err.issues[0];
    const path = issue?.path ?? [];
    const key = path[0] === "remote" ? path[1] : path[0];
    const envNames: Record<string, string> = {
      token: "BATON_TOKEN",
      summarizer: "BATON_SUMMARIZER",
      summarizerModel: "BATON_SUMMARIZER_MODEL",
      ollamaUrl: "BATON_OLLAMA_URL",
    };
    const label = (typeof key === "string" ? envNames[key] : undefined) ?? `--${flagName(key)}`;
    return { command: "error", message: `${label}: ${issue?.message}` };
  }
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      port: { type: "string" },
      host: { type: "string" },
      "projects-dir": { type: "string" },
      "codex-dir": { type: "string" },
      "state-file": { type: "string" },
      backlog: { type: "string" },
      "buffer-mb": { type: "string" },
      "buffer-size": { type: "string" },
      "active-minutes": { type: "string" },
      recent: { type: "string" },
      poll: { type: "boolean" },
      "log-level": { type: "string" },
      "web-dir": { type: "string" },
      server: { type: "string" },
      name: { type: "string" },
      "queue-dir": { type: "string" },
      "queue-mb": { type: "string" },
      speed: { type: "string" },
      as: { type: "string" },
      cwd: { type: "string" },
      "max-gap": { type: "string" },
      seed: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
}

const unexpected = (arg: string | undefined): CliResult => ({
  command: "error",
  message: `unexpected argument: ${arg}`,
});

function firstSet(values: Record<string, unknown>, flags: readonly string[]): string | undefined {
  return flags.find((f) => values[f] !== undefined);
}

/** `bufferSize` → `buffer-size`; `maxGap` → `max-gap`. */
const flagName = (key: PropertyKey | undefined) =>
  String(key ?? "").replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** Runs the CLI; resolves once the command has started (start/serve then run until a signal). */
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

  if (result.command === "replay") {
    const { logLevel, ...options } = result.options;
    const logger = pino({ level: logLevel });
    const abort = new AbortController();
    process.once("SIGINT", () => abort.abort(new Error("interrupted")));
    process.once("SIGTERM", () => abort.abort(new Error("terminated")));
    try {
      await runReplay({ ...options, logger, signal: abort.signal });
    } catch (err) {
      if (!abort.signal.aborted) logger.fatal({ err }, "replay failed");
      process.exitCode = 1;
    }
    return;
  }

  const logger = pino({ level: result.config.logLevel });
  let close: () => Promise<void>;
  try {
    close = await startCommand(result, logger);
  } catch (err) {
    logger.fatal({ err }, "baton could not start");
    process.exitCode = 1;
    return;
  }

  const stop = (signal: NodeJS.Signals) => {
    logger.info({ signal }, "shutting down");
    close().then(
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

async function startCommand(
  result: Extract<CliResult, { command: "start" | "serve" }>,
  logger: Logger,
): Promise<() => Promise<void>> {
  if (result.command === "serve") {
    const server = await startTeamServer(result.config, logger, {
      canvasFile: join(dirname(defaultStateFile()), "team-canvas.json"),
      handoffsFile: join(dirname(defaultStateFile()), "team-handoffs.json"),
    });
    logger.info(
      { host: result.config.host, port: server.port },
      `baton team server is running on port ${server.port}`,
    );
    return server.close;
  }
  const { config } = result;
  if (config.remote) {
    const forwarder = await startForwarder(config, config.remote, logger);
    logger.info(
      { server: config.remote.server, name: config.remote.name },
      "baton is streaming to the team server",
    );
    return forwarder.close;
  }
  const daemon = await startDaemon(config, logger);
  logger.info(
    {
      viewer: `${daemon.url}/`,
      ws: `${daemon.url.replace("http", "ws")}/ws`,
      sessions: `${daemon.url}/sessions`,
    },
    `baton is running: open ${daemon.url}/`,
  );
  return daemon.close;
}
