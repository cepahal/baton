/** Stops the service; resolves once it has saved its state. */
export type Close = () => Promise<void>;

export type RunServiceOptions = {
  /** Starts the service. `onRefused` may fire before this resolves. */
  start(onRefused: (message: string) => void): Promise<Close>;
  /** Tells the owner why the server refused (stderr, in the CLI). */
  report(message: string): void;
  /** Ends the process (`process.exit`, in the CLI). */
  exit(code: number): void;
};

/**
 * Runs a long-lived command that a team server can refuse for good. A refusal
 * closes the service (saving offsets and the queue) and then exits 1, even when
 * it arrives while the service is still starting and `close` doesn't exist yet.
 */
export async function runService(options: RunServiceOptions): Promise<Close> {
  let close: Close | undefined;
  let refused = false;
  const shutdown = (c: Close) => {
    c().then(
      () => options.exit(1),
      () => options.exit(1),
    );
  };
  close = await options.start((message) => {
    if (refused) return;
    refused = true;
    options.report(message);
    if (close) shutdown(close);
  });
  if (refused) shutdown(close);
  return close;
}
