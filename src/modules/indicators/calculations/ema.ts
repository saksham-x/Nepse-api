import { assertPeriod } from './sma.js';

/**
 * Exponential moving average with smoothing k = 2 / (period + 1).
 * Seeded with the SMA of the first `period` defined values; earlier points are null.
 * Leading nulls in the input (e.g. an upstream warm-up) are skipped.
 */
export function ema(values: readonly (number | null)[], period: number): (number | null)[] {
  assertPeriod(period);
  const out: (number | null)[] = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  const start = values.findIndex((v) => v !== null);
  if (start === -1 || values.length - start < period) return out;

  let seed = 0;
  for (let i = start; i < start + period; i++) seed += values[i] as number;
  let prev = seed / period;
  out[start + period - 1] = prev;

  for (let i = start + period; i < values.length; i++) {
    const v = values[i];
    if (v === null || v === undefined) throw new RangeError('ema input must not contain gaps after its first value');
    prev = v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}
