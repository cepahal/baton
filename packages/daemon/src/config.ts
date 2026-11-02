import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonName } from "@baton/core";
import { z } from "zod";

export const DEFAULT_PORT = 7777;
/** Memory for replayable events; roughly a few hundred long sessions. */
export const DEFAULT_BUFFER_MB = 256;
/** The daemon never listens on anything but loopback. */
export const HOST = "127.0.0.1";
/** `baton serve` listens on every interface: teammates connect from other machines. */
export const TEAM_HOST = "0.0.0.0";
/** Disk budget for events waiting to reach a team server. */
export const DEFAULT_QUEUE_MB = 64;
/** Shortest team token `baton serve` accepts. */
export const MIN_TOKEN_LENGTH = 16;

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

const int = (min: number) => z.coerce.number().int().min(min);

/** Daemon settings after defaults are applied. */
export const DaemonConfig = z.object({
  port: int(0).max(65535),
  projectsDir: z.string().min(1),
  stateFile: z.string().min(1),
  /** History events sent per session: a count, or "all". */
  backlog: z.union([z.literal("all"), int(0)]),
  /** Memory budget, in MB, for the events kept for viewers. */
  bufferMb: int(1),
  /** Optional cap on the number of events kept as well. */
  bufferSize: int(1).optional(),
  /** Minutes since a session's last change for it to count as active. */
  activeMinutes: int(1),
  poll: z.boolean(),
  logLevel: z.enum(LOG_LEVELS),
  /** Built viewer (`apps/web/dist`) served at `/`. */
  webDir: z.string().min(1),
  /** Send events to a team server instead of serving them locally. */
  remote: z
    .object({
      server: z.url({ protocol: /^(wss?|https?)$/ }),
      token: z.string().min(1),
      name: DaemonName,
      /** Directory of the on-disk send queue. */
      queueDir: z.string().min(1),
      queueMb: int(1),
    })
    .optional(),
});
export type DaemonConfig = z.infer<typeof DaemonConfig>;
export type RemoteConfig = NonNullable<DaemonConfig["remote"]>;

/** `baton serve` settings after defaults are applied. */
export const ServeConfig = z.object({
  host: z.string().min(1),
  port: int(0).max(65535),
  token: z
    .string()
    .min(MIN_TOKEN_LENGTH, `BATON_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`),
  bufferMb: int(1),
  bufferSize: int(1).optional(),
  activeMinutes: int(1),
  logLevel: z.enum(LOG_LEVELS),
  webDir: z.string().min(1),
});
export type ServeConfig = z.infer<typeof ServeConfig>;

/** A display name from the OS username, reduced to the characters a name allows. */
export function defaultDaemonName(): string {
  let name = "";
  try {
    name = userInfo().username;
  } catch {
    // no passwd entry, e.g. an arbitrary container uid
  }
  const clean = name
    .replace(/[^p{L}p{N} ._@-]/gu, "-")
    .slice(0, 64)
    .trim();
  return clean === "" ? "baton" : clean;
}

/** `apps/web/dist` in this repo; the same depth from `src/` and `dist/`. */
export const defaultWebDir = () =>
  fileURLToPath(new URL("../../../apps/web/dist", import.meta.url));

export const defaultProjectsDir = () => join(homedir(), ".claude", "projects");

/** `%LOCALAPPDATA%\baton` on Windows, `$XDG_STATE_HOME/baton` or `~/.local/state/baton` elsewhere. */
export function defaultStateFile(env: NodeJS.ProcessEnv = process.env): string {
  const base =
    process.platform === "win32"
      ? (env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"))
      : (env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"));
  return join(base, "baton", "state.json");
}

/** Fills in defaults and validates. Throws a ZodError on bad values. */
export function resolveConfig(
  input: Partial<Record<Exclude<keyof DaemonConfig, "remote">, unknown>> & {
    remote?: Partial<Record<keyof RemoteConfig, unknown>> | undefined;
  },
): DaemonConfig {
  const stateFile = input.stateFile ?? defaultStateFile();
  const config = DaemonConfig.parse({
    port: input.port ?? DEFAULT_PORT,
    projectsDir: input.projectsDir ?? defaultProjectsDir(),
    stateFile,
    backlog: input.backlog ?? "all",
    bufferMb: input.bufferMb ?? DEFAULT_BUFFER_MB,
    bufferSize: input.bufferSize,
    activeMinutes: input.activeMinutes ?? 120,
    poll: input.poll ?? false,
    logLevel: input.logLevel ?? "info",
    webDir: input.webDir ?? defaultWebDir(),
    remote: input.remote && {
      server: input.remote.server,
      token: input.remote.token,
      name: input.remote.name ?? defaultDaemonName(),
      queueDir:
        input.remote.queueDir ??
        (typeof stateFile === "string" ? join(dirname(stateFile), "queue") : undefined),
      queueMb: input.remote.queueMb ?? DEFAULT_QUEUE_MB,
    },
  });
  return {
    ...config,
    projectsDir: resolve(config.projectsDir),
    stateFile: resolve(config.stateFile),
    webDir: resolve(config.webDir),
    ...(config.remote
      ? { remote: { ...config.remote, queueDir: resolve(config.remote.queueDir) } }
      : {}),
  };
}

/** Fills in `baton serve` defaults and validates. Throws a ZodError on bad values. */
export function resolveServeConfig(
  input: Partial<Record<keyof ServeConfig, unknown>>,
): ServeConfig {
  const config = ServeConfig.parse({
    host: input.host ?? TEAM_HOST,
    port: input.port ?? DEFAULT_PORT,
    token: input.token,
    bufferMb: input.bufferMb ?? DEFAULT_BUFFER_MB,
    bufferSize: input.bufferSize,
    activeMinutes: input.activeMinutes ?? 24 * 60,
    logLevel: input.logLevel ?? "info",
    webDir: input.webDir ?? defaultWebDir(),
  });
  return { ...config, webDir: resolve(config.webDir) };
}
