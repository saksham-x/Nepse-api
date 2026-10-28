import { round } from '../../common/utils/serialize.js';
import { isValidTradeDate } from '../../common/utils/time.js';
import type { NormalizedCandle, SkippedRecord, SkipReason } from './ingestion.types.js';

export interface RawCandleValues {
  tradeDate: string;
  open: number | null | undefined;
  high: number | null | undefined;
  low: number | null | undefined;
  close: number | null | undefined;
  volume: number | bigint | null | undefined;
}

export type CandleCheck =
  | { ok: true; open: number; high: number; low: number; close: number; volume: bigint }
  | { ok: false; reason: SkipReason; message: string };

const MAX_PRICE = 9_999_999_999; // DECIMAL(14,4) integer part

const isPrice = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= MAX_PRICE;

/** Enforces candle invariants. Never fills in or guesses missing values. */
export function checkCandle(raw: RawCandleValues, today: string): CandleCheck {
  if (!isValidTradeDate(raw.tradeDate)) {
    return { ok: false, reason: 'INVALID_DATE', message: `invalid trade date '${raw.tradeDate}'` };
  }
  if (raw.tradeDate > today) {
    return { ok: false, reason: 'FUTURE_DATE', message: `trade date ${raw.tradeDate} is after ${today}` };
  }
  if (!isPrice(raw.open) || !isPrice(raw.high) || !isPrice(raw.low) || !isPrice(raw.close)) {
    return { ok: false, reason: 'INVALID_PRICES', message: 'open, high, low and close must all be positive numbers' };
  }
  // Round to the stored DECIMAL(14,4) scale so re-ingestion compares equal.
  const [open, high, low, close] = [raw.open, raw.high, raw.low, raw.close].map((v) => round(v, 4)) as [
    number,
    number,
    number,
    number,
  ];
  if (low > high || low > Math.min(open, close) || high < Math.max(open, close)) {
    return {
      ok: false,
      reason: 'OHLC_INCONSISTENT',
      message: `inconsistent OHLC o=${open} h=${high} l=${low} c=${close}`,
    };
  }
  let volume: bigint;
  if (typeof raw.volume === 'bigint') {
    volume = raw.volume;
  } else if (typeof raw.volume === 'number' && Number.isSafeInteger(raw.volume)) {
    volume = BigInt(raw.volume);
  } else {
    return { ok: false, reason: 'INVALID_VOLUME', message: `volume must be an integer, got ${String(raw.volume)}` };
  }
  if (volume < 0n) return { ok: false, reason: 'INVALID_VOLUME', message: 'volume must not be negative' };
  return { ok: true, open, high, low, close, volume };
}

export interface StoredCandle {
  tradeDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: bigint;
  trades: number | null;
  isProvisional: boolean;
}

export interface CandleDiff {
  toWrite: NormalizedCandle[];
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: SkippedRecord[];
}

const sameValues = (a: StoredCandle, b: NormalizedCandle): boolean =>
  a.open === b.open &&
  a.high === b.high &&
  a.low === b.low &&
  a.close === b.close &&
  a.volume === b.volume &&
  (b.trades === null || a.trades === b.trades) &&
  a.isProvisional === b.isProvisional;

/**
 * Decides what to write for incoming candles of a single instrument, given what
 * is already stored. Re-ingesting identical data writes nothing; differing
 * values are corrections and are written. A provisional candle never replaces
 * a final one. With `overwrite: false` differing stored rows are left alone and
 * reported as conflicts.
 */
export function diffCandles(
  stored: ReadonlyMap<string, StoredCandle>,
  incoming: readonly NormalizedCandle[],
  options: { overwrite: boolean; symbol?: string },
): CandleDiff {
  const result: CandleDiff = { toWrite: [], inserted: 0, updated: 0, unchanged: 0, skipped: [] };
  for (const candle of incoming) {
    const existing = stored.get(candle.tradeDate);
    if (!existing) {
      result.toWrite.push(candle);
      result.inserted++;
    } else if (sameValues(existing, candle)) {
      result.unchanged++;
    } else if (!existing.isProvisional && candle.isProvisional) {
      result.skipped.push({
        symbol: options.symbol,
        tradeDate: candle.tradeDate,
        reason: 'PROVISIONAL_OVER_FINAL',
        message: 'a final candle is already stored for this session',
      });
    } else if (!options.overwrite) {
      result.skipped.push({
        symbol: options.symbol,
        tradeDate: candle.tradeDate,
        reason: 'CONFLICT_NOT_OVERWRITTEN',
        message: 'stored candle differs; rerun with --overwrite to replace it',
      });
    } else {
      result.toWrite.push(candle);
      result.updated++;
    }
  }
  return result;
}
