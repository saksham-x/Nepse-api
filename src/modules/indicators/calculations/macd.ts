import { ema } from './ema.js';

export interface MacdPoint {
  macd: number;
  signal: number;
  histogram: number;
}

/**
 * MACD line = EMA(fast) - EMA(slow), defined from index slow - 1.
 * Signal = EMA(signal) of the MACD line, seeded with the SMA of its first
 * `signal` values, so the first full point is at index slow + signal - 2.
 * Histogram = MACD - signal.
 */
export function macd(closes: readonly number[], fast: number, slow: number, signal: number): (MacdPoint | null)[] {
  if (fast >= slow) throw new RangeError('fast period must be shorter than slow period');
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const line = closes.map((_, i) => {
    const f = fastEma[i];
    const s = slowEma[i];
    return f === null || f === undefined || s === null || s === undefined ? null : f - s;
  });
  const signalLine = ema(line, signal);
  return line.map((m, i) => {
    const s = signalLine[i];
    return m === null || s === null || s === undefined ? null : { macd: m, signal: s, histogram: m - s };
  });
}
