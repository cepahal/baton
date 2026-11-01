export type BackoffOptions = {
  /** Delay before the first retry. */
  baseMs: number;
  /** Upper bound on any delay. */
  maxMs: number;
};

export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 500, maxMs: 15_000 };

/**
 * Exponential backoff with jitter: `base * 2^attempt`, capped at `max`, then
 * scaled into [50%, 100%] so many viewers don't reconnect in lockstep.
 */
export function backoffDelay(
  attempt: number,
  options: BackoffOptions = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(options.maxMs, options.baseMs * 2 ** Math.max(0, attempt));
  return Math.round(ceiling * (0.5 + random() / 2));
}
