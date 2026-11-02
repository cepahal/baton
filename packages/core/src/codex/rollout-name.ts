/** What a Codex rollout file name says about the session it belongs to. */
export type RolloutName = {
  /** `YYYY-MM-DDTHH-MM-SS`, local time; sorts in creation order. */
  time: string;
  /** The thread (Baton session) the file belongs to. */
  threadId: string;
  /** Set on segment files, which continue `threadId` after a rewind. */
  segmentId?: string;
  /** `.jsonl.zst`: compressed by Codex once the session went idle. */
  compressed: boolean;
};

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ROLLOUT_NAME_RE = new RegExp(
  String.raw`^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-(${UUID})(?:_(${UUID}))?\.jsonl(\.zst)?$`,
  "i",
);

/** Parses `rollout-<time>-<threadId>[_<segmentId>].jsonl[.zst]`; `undefined` for other names. */
export function parseRolloutName(path: string): RolloutName | undefined {
  const name = path.split(/[\\/]/).pop() ?? path;
  const m = ROLLOUT_NAME_RE.exec(name);
  const [, time, threadId, segmentId, zst] = m ?? [];
  if (time === undefined || threadId === undefined) return undefined;
  return {
    time,
    threadId: threadId.toLowerCase(),
    ...(segmentId === undefined ? {} : { segmentId: segmentId.toLowerCase() }),
    compressed: zst !== undefined,
  };
}
