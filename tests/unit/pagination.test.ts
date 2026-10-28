import { describe, expect, it } from 'vitest';
import { addDays, dayOfWeek } from '../../src/common/utils/time.js';
import { aggregate, MAX_DAYS_PER_BUCKET } from '../../src/modules/market-data/aggregation.js';
import { buildPage, resolveRange } from '../../src/modules/market-data/market-data.service.js';
import type { DailyBar, Interval } from '../../src/modules/market-data/market-data.types.js';
import { candleRangeSchema } from '../../src/modules/market-data/market-data.validation.js';

/** Sun-Thu sessions with a holiday gap, like the NEPSE calendar. */
function tradingDays(from: string, count: number): DailyBar[] {
  const out: DailyBar[] = [];
  let d = from;
  let i = 0;
  while (out.length < count) {
    const dow = dayOfWeek(d);
    const holiday = d >= '2024-03-10' && d <= '2024-03-14';
    if (dow <= 4 && !holiday) {
      i++;
      out.push({ time: d, open: 100 + i, high: 110 + i, low: 90 + i, close: 105 + i, volume: 1000 + i, provisional: false });
    }
    d = addDays(d, 1);
  }
  return out;
}

const DATA = tradingDays('2023-01-01', 600);

/** Emulates findDailyBarsDesc: [from, before), newest first, limited. */
function fetchDesc(from: string | undefined, before: string, take: number): DailyBar[] {
  return DATA.filter((b) => (!from || b.time >= from) && b.time < before).reverse().slice(0, take);
}

function page(query: Record<string, string>) {
  const q = candleRangeSchema.parse(query);
  const range = resolveRange(q, '2026-01-01');
  const take = (range.limit + 1) * MAX_DAYS_PER_BUCKET[range.interval];
  return buildPage(fetchDesc(range.fromInclusive, range.beforeExclusive, take), range.interval, range.limit, take);
}

function walkBackwards(interval: Interval, limit: number, extra: Record<string, string> = {}) {
  const all = [];
  let before: string | undefined;
  for (let guard = 0; guard < 1000; guard++) {
    const p = page({ interval, limit: String(limit), ...extra, ...(before ? { before } : {}) });
    all.unshift(...p.candles);
    if (!p.hasMore) break;
    expect(p.nextBefore).toBe(p.candles[0]?.time);
    before = p.nextBefore!;
  }
  return all;
}

describe('candle pagination', () => {
  it.each([
    ['1d', 1], ['1d', 7], ['1d', 100], ['1d', 1000],
    ['1w', 1], ['1w', 3], ['1w', 50],
    ['1mo', 1], ['1mo', 4], ['1mo', 12],
  ] as [Interval, number][])('%s with limit %i reassembles the full series without gaps or duplicates', (interval, limit) => {
    const pages = walkBackwards(interval, limit);
    expect(pages).toEqual(aggregate(DATA, interval));
  });

  it('returns candles in ascending order', () => {
    const p = page({ limit: '50' });
    const times = p.candles.map((c) => c.time);
    expect(times).toEqual([...times].sort());
    expect(times).toHaveLength(50);
    expect(times.at(-1)).toBe(DATA.at(-1)?.time);
  });

  it('treats from and to as inclusive', () => {
    const p = page({ from: '2023-01-02', to: '2023-01-04', limit: '100' });
    expect(p.candles.map((c) => c.time)).toEqual(['2023-01-02', '2023-01-03', '2023-01-04']);
    expect(p.hasMore).toBe(false);
  });

  it('treats before as exclusive', () => {
    const p = page({ before: '2023-01-04', limit: '2' });
    expect(p.candles.map((c) => c.time)).toEqual(['2023-01-02', '2023-01-03']);
  });

  it('respects from while paging backwards', () => {
    const pages = walkBackwards('1d', 7, { from: '2023-06-01', to: '2023-08-31' });
    expect(pages).toEqual(DATA.filter((b) => b.time >= '2023-06-01' && b.time <= '2023-08-31'));
  });

  it('aligns from to the bucket start so the first week is complete', () => {
    const p = page({ interval: '1w', from: '2023-01-04', to: '2023-01-12', limit: '10' }); // Wed..Thu next week
    expect(p.candles.map((c) => c.time)).toEqual(['2023-01-01', '2023-01-08']);
    expect(p.candles[0]?.open).toBe(DATA[0]?.open); // includes Sun-Tue of the first week
  });

  it('keeps holiday weeks as gaps instead of inventing candles', () => {
    const weeks = aggregate(DATA, '1w').map((c) => c.time);
    expect(weeks).not.toContain('2024-03-10');
  });

  it('aggregates OHLCV correctly', () => {
    const week = aggregate(DATA.slice(0, 5), '1w')[0]!;
    const days = DATA.filter((b) => b.time >= '2023-01-01' && b.time <= '2023-01-07');
    expect(week).toEqual({
      time: '2023-01-01',
      open: days[0]!.open,
      high: Math.max(...days.map((d) => d.high)),
      low: Math.min(...days.map((d) => d.low)),
      close: days.at(-1)!.close,
      volume: days.reduce((s, d) => s + d.volume, 0),
      provisional: false,
    });
  });

  it('returns an empty last page when there is no older data', () => {
    const p = page({ before: '2022-01-01' });
    expect(p).toEqual({ candles: [], hasMore: false, nextBefore: null });
  });
});
