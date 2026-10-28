import { round } from '../../common/utils/serialize.js';
import { kathmanduDate } from '../../common/utils/time.js';
import { requireInstrument } from '../instruments/instruments.service.js';
import { getCandlePage, getFullSeries, resolveRange, seriesMeta } from '../market-data/market-data.service.js';
import { ema } from './calculations/ema.js';
import { macd } from './calculations/macd.js';
import { rsi } from './calculations/rsi.js';
import { sma } from './calculations/sma.js';
import type { IndicatorQuery } from './indicators.validation.js';

type Point = { time: string; value: number } | { time: string; macd: number; signal: number; histogram: number };

/** Number of bars before the first defined value, per indicator. */
export function warmupBars(q: IndicatorQuery): number {
  switch (q.type) {
    case 'sma':
    case 'ema':
      return q.period - 1;
    case 'rsi':
      return q.period;
    case 'macd':
      return q.slow + q.signal - 2;
  }
}

/** Computes the indicator over a full ascending close series. Pure. */
export function computeIndicator(closes: readonly number[], q: IndicatorQuery) {
  switch (q.type) {
    case 'sma':
      return sma(closes, q.period);
    case 'ema':
      return ema(closes, q.period);
    case 'rsi':
      return rsi(closes, q.period);
    case 'macd':
      return macd(closes, q.fast, q.slow, q.signal);
  }
}

/**
 * Indicator values aligned to the same page of candles that
 * GET /candles would return for the same range parameters.
 *
 * Values are computed over the instrument's entire stored history up to the end
 * of the page, so a value is identical no matter which page it appears on.
 * Points still inside the warm-up period are omitted.
 */
export async function getIndicator(symbol: string, q: IndicatorQuery) {
  const instrument = await requireInstrument(symbol);
  const range = resolveRange(q, kathmanduDate());
  const page = await getCandlePage(instrument, range);
  const meta = await seriesMeta(instrument, q.interval, page);

  const params = q.type === 'macd' ? { fast: q.fast, slow: q.slow, signal: q.signal } : { period: q.period };
  const last = page.candles[page.candles.length - 1];
  if (!last) return { data: [] as Point[], meta: { ...meta, indicator: q.type, params, warmupBars: warmupBars(q), insufficientHistory: false } };

  // Same upper bound as the page, so the newest (possibly partial) bucket matches the candle exactly.
  const upto = await getFullSeries(instrument, q.interval, range.beforeExclusive);
  const values = computeIndicator(upto.map((c) => c.close), q);

  const pageTimes = new Set(page.candles.map((c) => c.time));
  const data: Point[] = [];
  upto.forEach((c, i) => {
    const v = values[i];
    if (v === null || v === undefined || !pageTimes.has(c.time)) return;
    data.push(
      typeof v === 'number'
        ? { time: c.time, value: round(v) }
        : { time: c.time, macd: round(v.macd), signal: round(v.signal), histogram: round(v.histogram) },
    );
  });

  return {
    data,
    meta: {
      ...meta,
      indicator: q.type,
      params,
      warmupBars: warmupBars(q),
      historyBars: upto.length,
      insufficientHistory: upto.length <= warmupBars(q),
      precision: 4,
    },
  };
}
