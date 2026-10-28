/**
 * Supported chart intervals. Only daily data exists at the source; weekly and
 * monthly candles are aggregated from stored daily candles. No intraday
 * intervals are offered because the source provides no intraday history.
 */
export const INTERVALS = ['1d', '1w', '1mo'] as const;
export type Interval = (typeof INTERVALS)[number];

/** A daily candle as read from storage, prices converted to numbers. */
export interface DailyBar {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  provisional: boolean;
}

/**
 * Chart candle. `time` is a trading date 'YYYY-MM-DD' (Asia/Kathmandu calendar).
 * For 1w/1mo it is the calendar start of the bucket (Sunday / 1st of month).
 */
export type Candle = DailyBar;

export interface LinePoint {
  time: string;
  value: number;
}

export type DataStatus = 'OK' | 'NO_DATA_IN_RANGE' | 'NO_DATA';

export interface CandlePage {
  candles: Candle[];
  hasMore: boolean;
  /** Pass as `before` to fetch the previous (older) page. */
  nextBefore: string | null;
}
