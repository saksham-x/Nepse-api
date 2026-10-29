import { describe, expect, it, vi } from 'vitest';
import { logger } from '../../src/config/logger.js';
import { graphPayloadId } from '../../src/modules/ingestion/providers/nepse.auth.js';
import { ProviderError } from '../../src/modules/ingestion/providers/provider-error.js';
import type { MarketStatus } from '../../src/modules/ingestion/providers/nepse.types.js';
import { createIndexFeed, type IndexFeedDeps } from '../../src/modules/market-index/index-feed.js';
import { mapIndexGraph, mapIndexSummary } from '../../src/modules/market-index/index.mapper.js';

const OPEN: MarketStatus = { isOpen: true, rawStatus: 'OPEN', asOf: null, asOfDate: null };
const CLOSED: MarketStatus = { ...OPEN, isOpen: false, rawStatus: 'CLOSE' };

const summary = (value: number, extra: Record<string, unknown> = {}) => [
  { id: 57, index: 'Sensitive Index', currentValue: 450 },
  { id: 58, index: 'NEPSE Index', currentValue: value, previousClose: 2000, high: 2050, low: 1990, generatedTime: '2024-06-12T12:00:00', ...extra },
];

describe('index mapper', () => {
  it('picks the NEPSE Index and derives change when the provider omits it', () => {
    const s = mapIndexSummary(summary(2020), OPEN, new Date('2024-06-12T06:00:00Z'));
    expect(s).toMatchObject({ name: 'NEPSE Index', value: 2020, change: 20, changePercent: 1, high: 2050, marketOpen: true });
    // 12:00 Kathmandu = 06:15 UTC.
    expect(s?.asOf).toBe('2024-06-12T06:15:00.000Z');
  });

  it('falls back to close and rejects unusable payloads', () => {
    expect(mapIndexSummary(summary(0, { currentValue: null, close: 1999 }), CLOSED, new Date())?.value).toBe(1999);
    expect(mapIndexSummary([{ id: 57, index: 'Sensitive Index', currentValue: 1 }], OPEN, new Date())).toBeNull();
    expect(mapIndexSummary({ not: 'a list' }, OPEN, new Date())).toBeNull();
  });

  it('accepts [time, value] pairs in seconds or ms and object points', () => {
    expect(mapIndexGraph([[1718171100000, 2001], [1718171040, 2000], { x: 1718171160, y: 2002 }, ['bad', 1], [1718171170, -1]])).toEqual([
      { time: 1718171040, value: 2000 },
      { time: 1718171100, value: 2001 },
      { time: 1718171160, value: 2002 },
    ]);
  });

  it('computes the salted graph payload id', () => {
    const salts = { salt1: 1, salt2: 2, salt3: 3, salt4: 4, salt5: 5 };
    expect(graphPayloadId(301, salts, 10)).toBe(301 + 4 * 10 - 3);
    expect(graphPayloadId(307, salts, 10)).toBe(307 + 2 * 10 - 1);
  });
});

describe('index feed', () => {
  function setup(overrides: Partial<IndexFeedDeps> = {}) {
    let now = new Date('2024-06-12T06:00:00Z');
    let value = 2010;
    let status = OPEN;
    const deps: IndexFeedDeps = {
      getSummary: vi.fn(async () => ({ data: summary(value), marketStatus: status })),
      getGraph: vi.fn(async () => ({ data: [[1718171000, 2001], [1718171100, 2005]], marketStatus: status })),
      hasSubscribers: () => true,
      publish: vi.fn(),
      logger,
      now: () => now,
      config: { openIntervalMs: 10_000, closedIntervalMs: 300_000, graphRetryMs: 60_000 },
      ...overrides,
    };
    return {
      deps,
      feed: createIndexFeed(deps),
      advance: (ms: number) => (now = new Date(now.getTime() + ms)),
      setValue: (v: number) => (value = v),
      close: () => (status = CLOSED),
    };
  }

  it('backfills the session from the graph and appends a point per poll', async () => {
    const t = setup();
    expect(await t.feed.tick()).toBe(10_000);
    expect(t.feed.state().points.map((p) => p.value)).toEqual([2001, 2005, 2010]);

    t.advance(10_000);
    t.setValue(2012);
    await t.feed.tick();
    expect(t.feed.state().points).toHaveLength(4);
    expect(t.deps.publish).toHaveBeenLastCalledWith({
      snapshot: expect.objectContaining({ value: 2012 }),
      point: { time: Math.floor(Date.parse('2024-06-12T06:00:10Z') / 1000), value: 2012 },
    });
    expect(t.deps.getGraph).toHaveBeenCalledTimes(1);
  });

  it('builds the series from polls when the graph fails, retrying it later', async () => {
    const t = setup({ getGraph: vi.fn(async () => Promise.reject(new ProviderError('http', 'HTTP 500'))) });
    await t.feed.tick();
    expect(t.feed.state().points).toHaveLength(1);
    t.advance(10_000);
    await t.feed.tick();
    expect(t.deps.getGraph).toHaveBeenCalledTimes(1);
    t.advance(60_000);
    await t.feed.tick();
    expect(t.deps.getGraph).toHaveBeenCalledTimes(2);
    expect(t.feed.state().points).toHaveLength(3);
  });

  it('stops adding points and slows down once the market closes', async () => {
    const t = setup();
    await t.feed.tick();
    t.close();
    t.advance(10_000);
    expect(await t.feed.tick()).toBe(300_000);
    expect(t.feed.state().points).toHaveLength(3);
  });

  it('does not poll without subscribers', async () => {
    const t = setup({ hasSubscribers: () => false });
    await t.feed.tick();
    expect(t.deps.getSummary).not.toHaveBeenCalled();
  });
});
