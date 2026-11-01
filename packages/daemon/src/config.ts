import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const DEFAULT_PORT = 7777;
/** Memory for replayable events; roughly a few hundred long sessions. */
export const DEFAULT_BUFFER_MB = 256;
/** The daemon never listens on anything but loopback. */
export const HOST = "127.0.0.1";

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
});
export type DaemonConfig = z.infer<typeof DaemonConfig>;

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
export function resolveConfig(input: Partial<Record<keyof DaemonConfig, unknown>>): DaemonConfig {
  const config = DaemonConfig.parse({
    port: input.port ?? DEFAULT_PORT,
    projectsDir: input.projectsDir ?? defaultProjectsDir(),
    stateFile: input.stateFile ?? defaultStateFile(),
    backlog: input.backlog ?? "all",
    bufferMb: input.bufferMb ?? DEFAULT_BUFFER_MB,
    bufferSize: input.bufferSize,
    activeMinutes: input.activeMinutes ?? 120,
    poll: input.poll ?? false,
    logLevel: input.logLevel ?? "info",
    webDir: input.webDir ?? defaultWebDir(),
  });
  return {
    ...config,
    projectsDir: resolve(config.projectsDir),
    stateFile: resolve(config.stateFile),
    webDir: resolve(config.webDir),
  };
}
