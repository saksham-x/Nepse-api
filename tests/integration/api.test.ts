/**
 * HTTP-level tests: routing, validation, response shapes and centralized errors.
 * Repositories and the ingestion service are mocked; no database or network.
 */
import request from 'supertest';
import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DailyBar } from '../../src/modules/market-data/market-data.types.js';

const state = vi.hoisted(() => ({
  instruments: new Map<string, Record<string, unknown>>(),
  bars: [] as DailyBar[],
  quote: null as Record<string, unknown> | null,
  refresh: vi.fn(async () => undefined),
  dbDown: false,
}));

vi.mock('../../src/modules/instruments/instruments.repository.js', () => ({
  findBySymbol: async (symbol: string) => {
    if (state.dbDown) throw new Prisma.PrismaClientInitializationError("Can't reach database server at db:3306", '6.19.3');
    return state.instruments.get(symbol) ?? null;
  },
  search: async () => [...state.instruments.values()],
  candleCoverage: async () => ({ first: new Date('2024-06-10T00:00:00Z'), last: new Date('2024-06-12T00:00:00Z'), count: 3 }),
}));

vi.mock('../../src/modules/market-data/market-data.repository.js', () => ({
  findDailyBarsDesc: async (p: { fromInclusive?: string; beforeExclusive?: string; take?: number }) =>
    state.bars
      .filter((b) => (!p.fromInclusive || b.time >= p.fromInclusive) && (!p.beforeExclusive || b.time < p.beforeExclusive))
      .reverse()
      .slice(0, p.take ?? Infinity),
  hasAnyCandle: async () => state.bars.length > 0,
  findQuote: async () => state.quote,
  lastSuccessfulSyncAt: async () => new Date('2024-06-12T10:00:00Z'),
}));

vi.mock('../../src/modules/ingestion/ingestion.service.js', () => ({
  getIngestionService: () => ({ refreshInstrument: state.refresh }),
}));

const { createApp } = await import('../../src/app.js');
const { env } = await import('../../src/config/env.js');
const { ProviderError } = await import('../../src/modules/ingestion/providers/provider-error.js');

const app = createApp();

const instrument = {
  id: 1,
  symbol: 'NICD83/84',
  nepseSecurityId: 1,
  name: 'NIC Debenture',
  sector: 'Corporate Debentures',
  instrumentType: 'Debenture',
  isActive: true,
  lastSyncedAt: new Date('2024-06-12T10:00:00Z'),
};
const adbl = { ...instrument, id: 2, symbol: 'ADBL', name: 'Agricultural Development Bank Limited', sector: 'Commercial Banks', instrumentType: 'Equity' };

const bar = (time: string, close: number): DailyBar => ({ time, open: close - 1, high: close + 2, low: close - 2, close, volume: 1000, provisional: false });

beforeEach(() => {
  state.instruments = new Map([[adbl.symbol, adbl], [instrument.symbol, instrument]]);
  state.bars = Array.from({ length: 40 }, (_, i) => bar(`2024-05-${String(i % 31 + 1).padStart(2, '0')}`, 100 + i)).slice(0, 31);
  state.quote = null;
  state.refresh.mockReset();
  state.dbDown = false;
  env.QUOTE_ON_DEMAND_REFRESH = false;
});

const expectError = (res: request.Response, status: number, code: string) => {
  expect(res.status).toBe(status);
  expect(res.body).toEqual({ error: expect.objectContaining({ code, message: expect.any(String), requestId: expect.any(String) }) });
  expect(res.body.error.stack).toBeUndefined();
};

describe('errors and middleware', () => {
  it('returns the central error shape for unknown routes', async () => {
    expectError(await request(app).get('/api/v1/nope'), 404, 'ROUTE_NOT_FOUND');
  });

  it('echoes a valid X-Request-Id and generates one otherwise', async () => {
    const res = await request(app).get('/api/v1/nope').set('X-Request-Id', 'abc-123');
    expect(res.headers['x-request-id']).toBe('abc-123');
    expect(res.body.error.requestId).toBe('abc-123');
    const bad = await request(app).get('/api/v1/nope').set('X-Request-Id', 'bad id with spaces');
    expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects invalid JSON bodies', async () => {
    const res = await request(app).post('/api/v1/instruments').set('Content-Type', 'application/json').send('{"broken"');
    expectError(res, 400, 'INVALID_JSON');
  });

  it('rejects oversized bodies', async () => {
    const res = await request(app).post('/api/v1/instruments').set('Content-Type', 'application/json').send(JSON.stringify({ a: 'x'.repeat(200_000) }));
    expectError(res, 413, 'PAYLOAD_TOO_LARGE');
  });

  it('hides database internals behind DATABASE_ERROR', async () => {
    state.dbDown = true;
    const res = await request(app).get('/api/v1/instruments/ADBL');
    expectError(res, 503, 'DATABASE_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('db:3306');
  });

  it('sets security headers', async () => {
    const res = await request(app).get('/api/v1/nope');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('instruments', () => {
  it('searches and ranks exact symbol matches first', async () => {
    const res = await request(app).get('/api/v1/instruments').query({ search: 'adbl' });
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toEqual({ symbol: 'ADBL', name: adbl.name, sector: 'Commercial Banks', instrumentType: 'Equity' });
  });

  it('returns details for symbols containing a slash', async () => {
    const res = await request(app).get(`/api/v1/instruments/${encodeURIComponent('nicd83/84')}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ symbol: 'NICD83/84', dailyCandles: { count: 3, firstDate: '2024-06-10', lastDate: '2024-06-12' } });
  });

  it('distinguishes an unknown symbol', async () => {
    expectError(await request(app).get('/api/v1/instruments/ZZZZ'), 404, 'INSTRUMENT_NOT_FOUND');
  });

  it('validates the symbol format', async () => {
    expectError(await request(app).get('/api/v1/instruments/bad%20symbol'), 400, 'VALIDATION_ERROR');
  });
});

describe('candles', () => {
  it('returns chart-ready ascending candles with paging metadata', async () => {
    const res = await request(app).get('/api/v1/market-data/ADBL/candles').query({ to: '2024-05-31', limit: 10 });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(10);
    expect(res.body.data[0]).toEqual({ time: '2024-05-22', open: 120, high: 123, low: 119, close: 121, volume: 1000, provisional: false });
    expect(res.body.meta).toMatchObject({
      symbol: 'ADBL',
      interval: '1d',
      source: 'nepalstock.com.np',
      adjusted: false,
      timezone: 'Asia/Kathmandu',
      hasMore: true,
      nextBefore: '2024-05-22',
      dataStatus: 'OK',
      lastSuccessfulSyncAt: '2024-06-12T10:00:00.000Z',
    });
  });

  it('pages backwards with before', async () => {
    const res = await request(app).get('/api/v1/market-data/ADBL/candles').query({ before: '2024-05-22', limit: 30 });
    expect(res.body.data.map((c: { time: string }) => c.time).at(-1)).toBe('2024-05-21');
    expect(res.body.meta.hasMore).toBe(false);
  });

  it('returns line data on request', async () => {
    const res = await request(app).get('/api/v1/market-data/ADBL/candles').query({ format: 'line', to: '2024-05-02', limit: 2 });
    expect(res.body.data).toEqual([{ time: '2024-05-01', value: 100 }, { time: '2024-05-02', value: 101 }]);
  });

  it('distinguishes an empty range from an instrument with no data', async () => {
    const empty = await request(app).get('/api/v1/market-data/ADBL/candles').query({ from: '2020-01-01', to: '2020-01-31' });
    expect(empty.status).toBe(200);
    expect(empty.body.meta.dataStatus).toBe('NO_DATA_IN_RANGE');
    state.bars = [];
    const none = await request(app).get('/api/v1/market-data/ADBL/candles');
    expect(none.body.meta.dataStatus).toBe('NO_DATA');
  });

  it.each([
    [{ interval: '5m' }],
    [{ from: '2024-06-10', to: '2024-06-01' }],
    [{ limit: '0' }],
    [{ limit: '5000' }],
    [{ before: 'yesterday' }],
  ])('rejects invalid query %o', async (query) => {
    const res = await request(app).get('/api/v1/market-data/ADBL/candles').query(query);
    expectError(res, 400, 'VALIDATION_ERROR');
    expect(res.body.error.details.issues.length).toBeGreaterThan(0);
  });
});

describe('quote', () => {
  const storedQuote = (fetchedAt: Date) => ({
    instrumentId: 2,
    businessDate: new Date('2024-06-12T00:00:00Z'),
    lastTradedPrice: new Prisma.Decimal('305.2'),
    previousClose: new Prisma.Decimal('299'),
    totalTradedQty: 12345n,
    totalTrades: 210,
    fiftyTwoWeekHigh: null,
    fiftyTwoWeekLow: null,
    sourceUpdatedAt: new Date('2024-06-12T09:15:00Z'),
    marketOpen: false,
    fetchedAt,
  });

  it('returns the stored quote with freshness metadata', async () => {
    state.quote = storedQuote(new Date(Date.now() - 10_000));
    const res = await request(app).get('/api/v1/market-data/ADBL/quote');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ symbol: 'ADBL', lastTradedPrice: 305.2, previousClose: 299, change: 6.2, changePercent: 2.07, totalTradedQuantity: 12345 });
    expect(res.body.meta.freshness).toMatchObject({ isStale: false, marketOpenAtFetch: false });
    expect(res.body.meta.refresh).toEqual({ attempted: false });
  });

  it('reports a quote that has never been stored', async () => {
    expectError(await request(app).get('/api/v1/market-data/ADBL/quote'), 404, 'QUOTE_NOT_AVAILABLE');
  });

  it('serves stale stored data with an honest refresh status when the upstream is down', async () => {
    env.QUOTE_ON_DEMAND_REFRESH = true;
    state.quote = storedQuote(new Date(Date.now() - 3_600_000));
    state.refresh.mockRejectedValueOnce(new ProviderError('network', 'ECONNREFUSED'));
    const res = await request(app).get('/api/v1/market-data/ADBL/quote');
    expect(res.status).toBe(200);
    expect(res.body.meta.freshness.isStale).toBe(true);
    expect(res.body.meta.refresh).toEqual({ attempted: true, succeeded: false, errorCode: 'UPSTREAM_UNAVAILABLE' });
  });

  it('returns UPSTREAM_TIMEOUT when nothing is stored and the refresh times out', async () => {
    env.QUOTE_ON_DEMAND_REFRESH = true;
    state.refresh.mockRejectedValueOnce(new ProviderError('timeout', 'timed out'));
    expectError(await request(app).get('/api/v1/market-data/ADBL/quote'), 504, 'UPSTREAM_TIMEOUT');
  });

  it('returns REFRESH_FAILED when the upstream answered with unusable data', async () => {
    env.QUOTE_ON_DEMAND_REFRESH = true;
    state.refresh.mockRejectedValueOnce(new ProviderError('invalid_response', 'no usable quote'));
    expectError(await request(app).get('/api/v1/market-data/ADBL/quote'), 502, 'REFRESH_FAILED');
  });
});

describe('indicators', () => {
  it('returns indicator values aligned to the candle page, warmed up from earlier history', async () => {
    const res = await request(app).get('/api/v1/indicators/ADBL').query({ type: 'sma', period: 5, to: '2024-05-31', limit: 3 });
    expect(res.status).toBe(200);
    // closes for 05-27..05-31 are 126..130 -> SMA(5) at 05-29 uses 05-25..05-29 = 124..128
    expect(res.body.data).toEqual([
      { time: '2024-05-29', value: 126 },
      { time: '2024-05-30', value: 127 },
      { time: '2024-05-31', value: 128 },
    ]);
    expect(res.body.meta).toMatchObject({ indicator: 'sma', params: { period: 5 }, warmupBars: 4, insufficientHistory: false, hasMore: true });
  });

  it('returns MACD points', async () => {
    const res = await request(app).get('/api/v1/indicators/ADBL').query({ type: 'macd', fast: 3, slow: 6, signal: 3, limit: 5 });
    expect(res.body.data).toHaveLength(5);
    expect(Object.keys(res.body.data[0])).toEqual(['time', 'macd', 'signal', 'histogram']);
  });

  it('flags insufficient history', async () => {
    const res = await request(app).get('/api/v1/indicators/ADBL').query({ type: 'sma', period: 200 });
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.insufficientHistory).toBe(true);
  });

  it('validates indicator parameters', async () => {
    expectError(await request(app).get('/api/v1/indicators/ADBL').query({ type: 'macd', fast: 30, slow: 10 }), 400, 'VALIDATION_ERROR');
    expectError(await request(app).get('/api/v1/indicators/ADBL'), 400, 'VALIDATION_ERROR');
  });
});
