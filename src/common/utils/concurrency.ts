export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `worker` over `items` with at most `limit` in flight. Stops starting new
 * items once `shouldStop` returns true. Worker errors are not caught here.
 */
export async function forEachLimit<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
  shouldStop: () => boolean = () => false,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !shouldStop()) {
      const index = next++;
      await worker(items[index] as T, index);
    }
  });
  await Promise.all(runners);
}
