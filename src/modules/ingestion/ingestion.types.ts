import type { CandleSource } from '@prisma/client';

/** A validated daily candle ready to be written. Prices are plain numbers from the source. */
export interface NormalizedCandle {
  instrumentId: number;
  tradeDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: bigint;
  trades: number | null;
  isProvisional: boolean;
  source: CandleSource;
}

export interface NormalizedQuote {
  instrumentId: number;
  businessDate: string;
  lastTradedPrice: number;
  previousClose: number | null;
  totalTradedQty: bigint | null;
  totalTrades: number | null;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
  sourceUpdatedAt: Date | null;
  marketOpen: boolean;
  fetchedAt: Date;
}

/** Only fields the provider actually supplied; never used to blank stored values. */
export interface InstrumentPatch {
  instrumentId: number;
  name?: string;
  sector?: string;
  instrumentType?: string;
  lastSyncedAt: Date;
}

export type SkipReason =
  | 'INVALID_RECORD'
  | 'SYMBOL_MISMATCH'
  | 'NO_TRADES'
  | 'INVALID_DATE'
  | 'FUTURE_DATE'
  | 'INVALID_PRICES'
  | 'INVALID_VOLUME'
  | 'OHLC_INCONSISTENT'
  | 'UNKNOWN_SYMBOL'
  | 'OUT_OF_RANGE'
  | 'DUPLICATE_IN_INPUT'
  | 'PROVISIONAL_OVER_FINAL'
  | 'CONFLICT_NOT_OVERWRITTEN';

export interface SkippedRecord {
  symbol?: string;
  tradeDate?: string;
  line?: number;
  reason: SkipReason;
  message: string;
}

export interface WriteCounts {
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
}
