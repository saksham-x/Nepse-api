import { assertPeriod } from './sma.js';

/**
 * Relative Strength Index using Wilder's smoothing.
 *
 * - change[i] = close[i] - close[i-1]
 * - The first average gain/loss is the simple mean over changes 1..period, so
 *   the first RSI value is at index `period` (needs period + 1 closes).
 * - Afterwards avg = (prevAvg * (period - 1) + current) / period.
 * - RSI = 100 - 100 / (1 + avgGain / avgLoss). If avgLoss is 0, RSI is 100;
 *   if both averages are 0 (flat prices), RSI is 50.
 */
export function rsi(closes: readonly number[], period: number): (number | null)[] {
  assertPeriod(period);
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const change = (closes[i] as number) - (closes[i - 1] as number);
    if (change > 0) gain += change;
    else loss -= change;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = toRsi(avgGain, avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const change = (closes[i] as number) - (closes[i - 1] as number);
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
    out[i] = toRsi(avgGain, avgLoss);
  }
  return out;
}

function toRsi(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}
