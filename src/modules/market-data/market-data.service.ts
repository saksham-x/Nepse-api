import type { Instrument, Quote } from '@prisma/client';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { AppError, ErrorCode } from '../../common/errors/app-error.js';
import { toAppError } from '../../common/middleware/error-handler.js';
import { bigintToNumber, decimalToNumber, round } from '../../common/utils/serialize.js';
import { addDays, EXCHANGE_TIMEZONE, kathmanduDate, tradeDateFromDb } from '../../common/utils/time.js';
import { requireInstrument } from '../instruments/instruments.service.js';
import { getIngestionService } from '../ingestion/ingestion.service.js';
import { NEPSE_SOURCE } from '../ingestion/providers/nepse.provider.js';
import { ProviderError } from '../ingestion/providers/provider-error.js';
import { aggregate, bucketStart, MAX_DAYS_PER_BUCKET } from './aggregation.js';
import * as repo from './market-data.repository.js';
import type { Candle, CandlePage, DailyBar, DataStatus, Interval } from './market-data.types.js';
import type { CandleRangeQuery } from './market-data.validation.js';

export interface ResolvedRange {
  interval: Interval;
  limit: number;
  /** Inclusive lower bound, aligned to a bucket start. */
  fromInclusive?: string;
  /** Exclusive upper bound. */
  beforeExclusive: string;
}

export function resolveRange(query: CandleRangeQuery, today: string): ResolvedRange {
  const { interval, limit } = query;
  let beforeExclusive = addDays(query.to ?? today, 1);
  if (query.before) {
    // Align to a bucket start so an aggregated bucket is never split across pages.
    const aligned = bucketStart(query.before, interval);
    if (aligned < beforeExclusive) beforeExclusive = aligned;
  }
  return {
    interval,
    limit,
    beforeExclusive,
    ...(query.from ? { fromInclusive: bucketStart(query.from, interval) } : {}),
  };
}

/**
 * Builds one page from daily rows fetched newest-first with `take` =
 * (limit + 1) * max days per bucket. If the fetch was cut off, the oldest bucket
 * may be incomplete, so it is dropped and left for the next page; there are
 * always at least `limit` complete buckets left in that case.
 */
export function buildPage(rowsDesc: readonly DailyBar[], interval: Interval, limit: number, take: number): CandlePage {
  const cutOff = rowsDesc.length >= take;
  const buckets = aggregate([...rowsDesc].reverse(), interval);
  if (cutOff) buckets.shift();
  const candles = buckets.slice(-limit);
  const hasMore = cutOff || buckets.length > limit;
  return { candles, hasMore, nextBefore: hasMore && candles[0] ? candles[0].time : null };
}

export async function getCandlePage(instrument: Instrument, range: ResolvedRange): Promise<CandlePage> {
  const take = (range.limit + 1) * MAX_DAYS_PER_BUCKET[range.interval];
  const rows = await repo.findDailyBarsDesc({
    instrumentId: instrument.id,
    fromInclusive: range.fromInclusive,
    beforeExclusive: range.beforeExclusive,
    take,
  });
  return buildPage(rows, range.interval, range.limit, take);
}

/** Every candle strictly before `beforeExclusive`, ascending; used for indicator warm-up. */
export async function getFullSeries(instrument: Instrument, interval: Interval, beforeExclusive: string): Promise<Candle[]> {
  const rows = await repo.findDailyBarsDesc({ instrumentId: instrument.id, beforeExclusive });
  return aggregate(rows.reverse(), interval);
}

async function dataStatus(instrument: Instrument, page: CandlePage): Promise<DataStatus> {
  if (page.candles.length > 0) return 'OK';
  return (await repo.hasAnyCandle(instrument.id)) ? 'NO_DATA_IN_RANGE' : 'NO_DATA';
}

export async function seriesMeta(instrument: Instrument, interval: Interval, page: CandlePage) {
  const [status, lastSync] = await Promise.all([dataStatus(instrument, page), repo.lastSuccessfulSyncAt()]);
  const latest = page.candles[page.candles.length - 1];
  return {
    symbol: instrument.symbol,
    interval,
    source: NEPSE_SOURCE,
    adjusted: false,
    timezone: EXCHANGE_TIMEZONE,
    timeFormat: 'YYYY-MM-DD trading date',
    count: page.candles.length,
    hasMore: page.hasMore,
    nextBefore: page.nextBefore,
    dataStatus: status,
    latestCandleProvisional: latest?.provisional ?? false,
    instrumentLastSyncedAt: instrument.lastSyncedAt?.toISOString() ?? null,
    lastSuccessfulSyncAt: lastSync?.toISOString() ?? null,
  };
}

export async function getCandles(symbol: string, query: CandleRangeQuery & { format: 'ohlcv' | 'line' }) {
  const instrument = await requireInstrument(symbol);
  const page = await getCandlePage(instrument, resolveRange(query, kathmanduDate()));
  const meta = await seriesMeta(instrument, query.interval, page);
  const data =
    query.format === 'line'
      ? page.candles.map((c) => ({ time: c.time, value: c.close }))
      : page.candles;
  return { data, meta: { ...meta, format: query.format } };
}

function toQuoteDto(symbol: string, q: Quote) {
  const ltp = decimalToNumber(q.lastTradedPrice);
  const prev = decimalToNumber(q.previousClose);
  const change = prev === null ? null : round(ltp - prev, 4);
  return {
    symbol,
    businessDate: tradeDateFromDb(q.businessDate),
    lastTradedPrice: ltp,
    previousClose: prev,
    change,
    changePercent: change === null || !prev ? null : round((change / prev) * 100, 2),
    totalTradedQuantity: bigintToNumber(q.totalTradedQty),
    totalTrades: q.totalTrades,
    fiftyTwoWeekHigh: decimalToNumber(q.fiftyTwoWeekHigh),
    fiftyTwoWeekLow: decimalToNumber(q.fiftyTwoWeekLow),
    sourceUpdatedAt: q.sourceUpdatedAt?.toISOString() ?? null,
    fetchedAt: q.fetchedAt.toISOString(),
  };
}

export type QuoteDto = ReturnType<typeof toQuoteDto>;

/** Stored quote and newest daily candle for an instrument; what live subscribers receive. */
export async function getLiveSnapshot(instrument: Instrument): Promise<{ symbol: string; quote: QuoteDto | null; candle: Candle | null }> {
  const [quote, bars] = await Promise.all([
    repo.findQuote(instrument.id),
    repo.findDailyBarsDesc({ instrumentId: instrument.id, take: 1 }),
  ]);
  return { symbol: instrument.symbol, quote: quote ? toQuoteDto(instrument.symbol, quote) : null, candle: bars[0] ?? null };
}

const ageSeconds = (q: Quote, now: Date) => Math.max(0, Math.round((now.getTime() - q.fetchedAt.getTime()) / 1000));

export async function getQuote(symbol: string) {
  const instrument = await requireInstrument(symbol);
  let quote = await repo.findQuote(instrument.id);
  let refresh: { attempted: boolean; succeeded?: boolean; errorCode?: string } = { attempted: false };

  const isStale = !quote || ageSeconds(quote, new Date()) > env.QUOTE_MAX_AGE_SECONDS;
  if (isStale && env.QUOTE_ON_DEMAND_REFRESH) {
    try {
      await getIngestionService().refreshInstrument(instrument);
      quote = await repo.findQuote(instrument.id);
      refresh = { attempted: true, succeeded: true };
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      const appError = toAppError(err);
      logger.warn({ symbol, kind: err.kind, message: err.message }, 'on-demand quote refresh failed');
      // Without stored data the failure is the answer; with it, serve stored data and say so.
      if (!quote) throw appError;
      refresh = { attempted: true, succeeded: false, errorCode: appError.code };
    }
  }

  if (!quote) {
    throw AppError.notFound(ErrorCode.QUOTE_NOT_AVAILABLE, `No quote has been stored for '${symbol}' yet`, { symbol });
  }

  const now = new Date();
  const age = ageSeconds(quote, now);
  return {
    data: toQuoteDto(instrument.symbol, quote),
    meta: {
      source: NEPSE_SOURCE,
      freshness: {
        fetchedAt: quote.fetchedAt.toISOString(),
        ageSeconds: age,
        maxAgeSeconds: env.QUOTE_MAX_AGE_SECONDS,
        isStale: age > env.QUOTE_MAX_AGE_SECONDS,
        marketOpenAtFetch: quote.marketOpen,
      },
      refresh,
    },
  };
}
