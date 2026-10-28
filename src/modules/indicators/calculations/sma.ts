/**
 * Simple moving average.
 * out[i] = mean(values[i - period + 1 .. i]); null for the first period - 1 points.
 * Each window is summed directly (no running sum) to avoid accumulated float drift.
 */
export function sma(values: readonly number[], period: number): (number | null)[] {
  assertPeriod(period);
  return values.map((_, i) => {
    if (i < period - 1) return null;
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j] as number;
    return sum / period;
  });
}

export function assertPeriod(period: number): void {
  if (!Number.isInteger(period) || period < 1) throw new RangeError(`period must be a positive integer, got ${period}`);
}
