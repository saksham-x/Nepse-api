/**
 * Runs `tick` repeatedly; each run returns the delay before the next one.
 * Runs never overlap, and `stop()` waits for the current one to finish.
 */
export function createPollLoop(tick: () => Promise<number>, onError: (err: unknown) => number) {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let started = false;
  let stopRequested = false;

  function schedule(delayMs: number): void {
    if (!started) return;
    timer = setTimeout(() => {
      running = tick()
        .catch(onError)
        .then((next) => {
          running = undefined;
          schedule(next);
        });
    }, delayMs);
  }

  return {
    start(): void {
      if (started) return;
      started = true;
      stopRequested = false;
      schedule(0);
    },
    async stop(): Promise<void> {
      started = false;
      stopRequested = true;
      clearTimeout(timer);
      await running;
    },
    /** True once stop() was called; long ticks check it to end early. */
    stopRequested: () => stopRequested,
  };
}
