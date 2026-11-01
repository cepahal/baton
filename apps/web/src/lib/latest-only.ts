/**
 * Wraps an async call that may overlap with itself (e.g. polling) so a
 * response that settles after a newer call's response is dropped instead of
 * overwriting it.
 */
export function latestOnly<T>(
  fn: () => Promise<T>,
  onValue: (value: T) => void,
  onError: (error: unknown) => void,
): () => Promise<void> {
  let started = 0;
  let applied = 0;
  return async () => {
    const id = ++started;
    let result: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      result = { ok: true, value: await fn() };
    } catch (error) {
      result = { ok: false, error };
    }
    if (id < applied) return;
    applied = id;
    if (result.ok) onValue(result.value);
    else onError(result.error);
  };
}
