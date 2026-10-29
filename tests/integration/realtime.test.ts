/**
 * Socket.IO tests: subscriptions, live pushes and historical requests over the
 * socket. Repositories, the ingestion service and the provider are mocked.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DailyBar } from '../../src/modules/market-data/market-data.types.js';

const state = vi.hoisted(() => ({
  instruments: new Map<string, Record<string, unknown>>(),
  bars: [] as DailyBar[],
  quote: null as Record<string, unknown> | null,
  refresh: vi.fn(async () => undefined),
  indexValue: 2010,
}));

vi.mock('../../src/modules/instruments/instruments.repository.js', () => ({
  findBySymbol: async (symbol: string) => state.instruments.get(symbol) ?? null,
}));

vi.mock('../../src/modules/market-data/market-data.repository.js', () => ({
  findDailyBarsDesc: async (p: { beforeExclusive?: string; take?: number }) =>
    state.bars
      .filter((b) => !p.beforeExclusive || b.time < p.beforeExclusive)
      .reverse()
      .slice(0, p.take ?? Infinity),
  hasAnyCandle: async () => state.bars.length > 0,
  findQuote: async () => state.quote,
  lastSuccessfulSyncAt: async () => new Date('2024-06-12T10:00:00Z'),
}));

vi.mock('../../src/modules/ingestion/ingestion.service.js', () => ({
  getIngestionService: () => ({ refreshInstrument: state.refresh }),
}));

vi.mock('../../src/modules/ingestion/providers/nepse.provider.js', () => ({
  NEPSE_SOURCE: 'nepalstock.com.np',
  getNepseProvider: () => ({
    getMarketStatus: async () => ({ isOpen: true, rawStatus: 'OPEN', asOf: new Date('2024-06-12T05:00:00Z'), asOfDate: '2024-06-12' }),
    getIndexSummary: async () => ({
      data: [{ id: 58, index: 'NEPSE Index', currentValue: state.indexValue, previousClose: 2000 }],
      marketStatus: { isOpen: true, rawStatus: 'OPEN', asOf: null, asOfDate: null },
    }),
    getIndexGraph: async () => ({ data: [], marketStatus: { isOpen: true, rawStatus: 'OPEN', asOf: null, asOfDate: null } }),
  }),
}));

const { env } = await import('../../src/config/env.js');
const { attachRealtime } = await import('../../src/modules/realtime/realtime.server.js');

const adbl = { id: 1, symbol: 'ADBL', nepseSecurityId: 1, name: 'ADBL', isActive: true, lastSyncedAt: null };
const bar = (time: string, close: number): DailyBar => ({ time, open: close - 1, high: close + 2, low: close - 2, close, volume: 1000, provisional: false });
const quote = (ltp: number) => ({
  instrumentId: 1,
  businessDate: new Date('2024-06-12T00:00:00Z'),
  lastTradedPrice: ltp,
  previousClose: 100,
  totalTradedQty: 5000n,
  totalTrades: 42,
  fiftyTwoWeekHigh: null,
  fiftyTwoWeekLow: null,
  sourceUpdatedAt: null,
  marketOpen: true,
  fetchedAt: new Date(),
});

let server: Server;
let realtime: ReturnType<typeof attachRealtime>;
let client: Socket;

// Prisma Decimal values are converted with Number(); plain numbers behave the same.
const emit = <T = any>(event: string, payload?: unknown) => client.timeout(2000).emitWithAck(event, payload) as Promise<T>;

beforeAll(async () => {
  env.LIVE_FEED_ENABLED = false; // ticks are driven by the test
  server = createServer();
  realtime = attachRealtime(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  client = connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { transports: ['websocket'] });
  await new Promise<void>((resolve) => client.once('connect', resolve));
});

afterAll(async () => {
  client.close();
  await realtime.close();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(async () => {
  state.instruments = new Map([['ADBL', adbl]]);
  state.bars = [bar('2024-06-10', 101), bar('2024-06-11', 102), bar('2024-06-12', 103)];
  state.quote = quote(103);
  await emit('unsubscribe');
});

describe('historical data over the socket', () => {
  it('returns candles with the same shape as the REST endpoint', async () => {
    const res = await emit('candles:get', { symbol: 'adbl', limit: 2, format: 'line' });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual([{ time: '2024-06-11', value: 102 }, { time: '2024-06-12', value: 103 }]);
    expect(res.meta).toMatchObject({ symbol: 'ADBL', interval: '1d', hasMore: true, nextBefore: '2024-06-11' });
  });

  it('returns indicators and quotes', async () => {
    const ind = await emit('indicators:get', { symbol: 'ADBL', type: 'sma', period: 2 });
    expect(ind.ok).toBe(true);
    const q = await emit('quote:get', { symbol: 'ADBL' });
    expect(q.data).toMatchObject({ symbol: 'ADBL', lastTradedPrice: 103, change: 3 });
  });

  it('acknowledges errors with the REST error codes', async () => {
    expect(await emit('candles:get', { symbol: 'NOPE' })).toEqual({ ok: false, error: expect.objectContaining({ code: 'INSTRUMENT_NOT_FOUND' }) });
    expect((await emit('candles:get', { symbol: 'ADBL', limit: 0 })).error.code).toBe('VALIDATION_ERROR');
    expect((await emit('candles:get', 'garbage')).error.code).toBe('VALIDATION_ERROR');
  });
});

describe('live subscriptions', () => {
  it('returns a snapshot on subscribe and pushes changes to subscribers', async () => {
    const res = await emit('subscribe', { symbols: ['ADBL'] });
    expect(res.data.subscribed).toEqual(['ADBL']);
    expect(res.data.snapshots[0]).toMatchObject({ symbol: 'ADBL', quote: { lastTradedPrice: 103 }, candle: { time: '2024-06-12', close: 103 } });

    const pushed = new Promise<any>((resolve) => client.once('snapshot', resolve));
    const market = new Promise<any>((resolve) => client.once('market', resolve));
    state.quote = quote(105);
    state.bars.push({ ...bar('2024-06-13', 105), provisional: true });
    await realtime.feed.tick();

    expect(await pushed).toMatchObject({ symbol: 'ADBL', quote: { lastTradedPrice: 105 }, candle: { time: '2024-06-13', provisional: true } });
    expect(await market).toMatchObject({ isOpen: true, rawStatus: 'OPEN' });
    expect(state.refresh).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'ADBL' }));
  });

  it('stops polling a symbol once nobody is subscribed', async () => {
    await emit('subscribe', { symbols: ['ADBL'] });
    expect((await emit('unsubscribe', { symbols: ['ADBL'] })).data.subscribed).toEqual([]);
    state.refresh.mockClear();
    await realtime.feed.tick();
    expect(state.refresh).not.toHaveBeenCalled();
  });

  it('streams the NEPSE index to index subscribers', async () => {
    // No payload at all, as the dashboard sends it: the ack is then the only argument.
    const before = await client.timeout(2000).emitWithAck('index:subscribe');
    expect(before).toEqual({ ok: true, data: { snapshot: null, points: [] } });

    const pushed = new Promise<any>((resolve) => client.once('index', resolve));
    await realtime.indexFeed.tick();
    expect(await pushed).toMatchObject({ snapshot: { name: 'NEPSE Index', value: 2010, change: 10 }, point: { value: 2010 } });

    const again = await emit('index:subscribe');
    expect(again.data.points).toHaveLength(1);

    await emit('index:unsubscribe');
    state.indexValue = 2020;
    const silent = vi.fn();
    client.on('index', silent);
    await realtime.indexFeed.tick();
    await emit('quote:get', { symbol: 'ADBL' }); // round trip so any push would have arrived
    expect(silent).not.toHaveBeenCalled();
    client.off('index', silent);
  });

  it('rejects unknown symbols and too many symbols', async () => {
    expect((await emit('subscribe', { symbols: ['NOPE'] })).error.code).toBe('INSTRUMENT_NOT_FOUND');
    const many = Array.from({ length: env.LIVE_MAX_SYMBOLS_PER_CLIENT + 1 }, (_, i) => `S${i}`);
    expect((await emit('subscribe', { symbols: many })).error.code).toBe('VALIDATION_ERROR');
  });
});
