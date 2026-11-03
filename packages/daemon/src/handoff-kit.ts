import { join } from "node:path";
import type { Logger } from "pino";
import { localRoute } from "./handoff-route.js";
import { HandoffService } from "./handoff-service.js";
import { HandoffStore } from "./handoff-store.js";
import type { Hub } from "./hub.js";
import { Inbox, type InboxOptions } from "./inbox.js";
import { type Notifier, osNotify } from "./notify.js";
import type { Summarizer } from "./summarizer.js";
import { hasWindowsTerminal, type Launcher, launch } from "./terminal.js";

/** What touches the desktop: swapped out in tests. */
export type HandoffDeps = {
  notify?: Notifier | undefined;
  launch?: Launcher | undefined;
  summarize?: Summarizer | undefined;
  summarizeTimeoutMs?: number;
  inbox?: Partial<InboxOptions>;
};

/** Inbox options shared by the local daemon and the forwarder's local server. */
export function inboxOptions(
  dataDir: string,
  logger: Logger,
  deps: HandoffDeps,
): Omit<InboxOptions, "report" | "origin"> {
  return {
    logger,
    notify: "notify" in deps ? deps.notify : osNotify,
    launch: "launch" in deps ? deps.launch : launch,
    hasWindowsTerminal,
    foldersFile: join(dataDir, "repo-folders.json"),
    ...deps.inbox,
  };
}

/**
 * `baton start`: the hub, the service and the inbox all live in this process.
 * Offers go straight to the inbox; the inbox's answers straight to the service.
 */
export async function localHandoffs(options: {
  hub: Hub;
  dataDir: string;
  logger: Logger;
  origin: () => string;
  summarize?: Summarizer | undefined;
  deps?: HandoffDeps;
  /** Reads a note file accepted here (this machine is the hub). */
  fetchBlob?: (sha256: string) => Promise<Uint8Array | undefined>;
}): Promise<{ service: HandoffService; inbox: Inbox; store: HandoffStore }> {
  const store = new HandoffStore({
    file: join(options.dataDir, "handoffs.json"),
    logger: options.logger,
  });
  await store.load();
  let service: HandoffService | undefined;
  const inbox = new Inbox({
    ...inboxOptions(options.dataDir, options.logger, options.deps ?? {}),
    ...(options.fetchBlob ? { fetchBlob: options.fetchBlob } : {}),
    origin: options.origin,
    report: (message) => service?.fromDaemon(undefined, message),
  });
  service = new HandoffService({
    hub: options.hub,
    store,
    route: localRoute(inbox),
    logger: options.logger,
    summarize:
      options.deps && "summarize" in options.deps ? options.deps.summarize : options.summarize,
    ...(options.deps?.summarizeTimeoutMs === undefined
      ? {}
      : { summarizeTimeoutMs: options.deps.summarizeTimeoutMs }),
  });
  // The inbox lives in memory: offer it the handoffs still waiting from before a restart.
  service.daemonConnected(undefined);
  return { service, inbox, store };
}
