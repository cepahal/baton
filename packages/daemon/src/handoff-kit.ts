import { join } from "node:path";
import type { Logger } from "pino";
import type { BlobStore } from "./blob-store.js";
import { codeReply } from "./code-bundle.js";
import { type CodeReply, localRoute } from "./handoff-route.js";
import { HandoffService } from "./handoff-service.js";
import { HandoffStore } from "./handoff-store.js";
import type { Hub } from "./hub.js";
import { Inbox, type InboxOptions } from "./inbox.js";
import { type Notifier, osNotify } from "./notify.js";
import type { Summarizer } from "./summarizer.js";

/** What touches the desktop or the checkout: swapped out in tests. */
export type HandoffDeps = {
  notify?: Notifier | undefined;
  summarize?: Summarizer | undefined;
  summarizeTimeoutMs?: number;
  /** Bundles a session's uncommitted changes. Default: `git` in the session's folder. */
  code?: (dir: string | undefined) => Promise<CodeReply>;
  inbox?: Partial<InboxOptions>;
};

/** Inbox options shared by the local daemon and the forwarder. */
export function inboxOptions(logger: Logger, deps: HandoffDeps): Omit<InboxOptions, "origin"> {
  return {
    logger,
    notify: "notify" in deps ? deps.notify : osNotify,
    ...deps.inbox,
  };
}

/**
 * `baton start`: the hub, the service and the inbox all live in this process.
 * Offers go straight to the inbox, and the only browser is this machine's.
 */
export async function localHandoffs(options: {
  hub: Hub;
  dataDir: string;
  logger: Logger;
  origin: () => string;
  summarize?: Summarizer | undefined;
  deps?: HandoffDeps;
  /** Where note files and attached patches live (this machine is the hub). */
  blobs?: BlobStore;
}): Promise<{ service: HandoffService; inbox: Inbox; store: HandoffStore }> {
  const store = new HandoffStore({
    file: join(options.dataDir, "handoffs.json"),
    logger: options.logger,
  });
  await store.load();
  const { hub, blobs } = options;
  const deps = options.deps ?? {};
  const sessionDir = (sessionId: string) => hub.session(sessionId)?.projectPath;
  const inbox = new Inbox({
    ...(blobs ? { fetchBlob: (sha256: string) => blobs.read(sha256) } : {}),
    sessionDir,
    ...inboxOptions(options.logger, deps),
    origin: options.origin,
  });
  const bundle = deps.code ?? ((dir: string | undefined) => codeReply(dir));
  const service = new HandoffService({
    hub,
    store,
    route: localRoute(inbox, (sessionId) => bundle(sessionDir(sessionId))),
    logger: options.logger,
    ...(blobs ? { blobs } : {}),
    summarize: "summarize" in deps ? deps.summarize : options.summarize,
    ...(deps.summarizeTimeoutMs === undefined
      ? {}
      : { summarizeTimeoutMs: deps.summarizeTimeoutMs }),
  });
  // The inbox lives in memory: offer it the handoffs still waiting from before a restart.
  service.daemonConnected(undefined);
  return { service, inbox, store };
}
