/**
 * MySQL-specific repository behaviour: bulk upsert SQL, unique constraints,
 * COALESCE semantics, locking and range boundaries. Run with
 * `npm run test:integration` against a disposable *_test database.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/config/prisma.js';
import * as ingestionRepo from '../../src/modules/ingestion/ingestion.repository.js';
import type { NormalizedCandle } from '../../src/modules/ingestion/ingestion.types.js';
import * as marketRepo from '../../src/modules/market-data/market-data.repository.js';

let instrumentId: number;

const candle = (tradeDate: string, overrides: Partial<NormalizedCandle> = {}): NormalizedCandle => ({
  instrumentId,
  tradeDate,
  open: 100.25,
  high: 110.5,
  low: 99.125,
  close: 105.0001,
  volume: 9_007_199_254_740_991n,
  trades: 12,
  isProvisional: false,
  source: 'NEPSE',
  ...overrides,
});

beforeEach(async () => {
  await prisma.$transaction([
    prisma.dailyCandle.deleteMany(),
    prisma.quote.deleteMany(),
    prisma.instrument.deleteMany(),
    prisma.ingestionRun.deleteMany(),
    prisma.ingestionLock.deleteMany(),
  ]);
  instrumentId = (await prisma.instrument.create({ data: { symbol: 'TEST', nepseSecurityId: 1 } })).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('daily candle writes', () => {
  it('inserts in bulk and round-trips decimals and big volumes exactly', async () => {
    await ingestionRepo.writeBatch({ candles: [candle('2024-06-10'), candle('2024-06-11')], quotes: [], patches: [] });
    const bars = await marketRepo.findDailyBarsDesc({ instrumentId });
    expect(bars.map((b) => b.time)).toEqual(['2024-06-11', '2024-06-10']);
    expect(bars[0]).toMatchObject({ open: 100.25, high: 110.5, low: 99.125, close: 105.0001, volume: 9_007_199_254_740_991 });
  });

  it('upserts on (instrument, date) instead of duplicating, and keeps trades when missing', async () => {
    await ingestionRepo.writeBatch({ candles: [candle('2024-06-10')], quotes: [], patches: [] });
    await ingestionRepo.writeBatch({ candles: [candle('2024-06-10', { close: 106, trades: null })], quotes: [], patches: [] });
    const rows = await prisma.dailyCandle.findMany({ where: { instrumentId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.close.toString()).toBe('106');
    expect(rows[0]?.trades).toBe(12);
  });

  it('reads stored candles back for diffing', async () => {
    await ingestionRepo.writeBatch({ candles: [candle('2024-06-10', { isProvisional: true })], quotes: [], patches: [] });
    const stored = await ingestionRepo.getStoredCandles([{ instrumentId, tradeDate: '2024-06-10' }, { instrumentId, tradeDate: '2024-06-11' }]);
    expect([...(stored.get(instrumentId)?.keys() ?? [])]).toEqual(['2024-06-10']);
    expect(stored.get(instrumentId)?.get('2024-06-10')).toMatchObject({ close: 105.0001, isProvisional: true, volume: 9_007_199_254_740_991n });
    expect(await ingestionRepo.instrumentsWithFinalCandle([instrumentId], '2024-06-10')).toEqual(new Set());
  });

  it('applies [from, before) boundaries', async () => {
    await ingestionRepo.writeBatch({ candles: ['2024-06-09', '2024-06-10', '2024-06-11', '2024-06-12'].map((d) => candle(d)), quotes: [], patches: [] });
    const bars = await marketRepo.findDailyBarsDesc({ instrumentId, fromInclusive: '2024-06-10', beforeExclusive: '2024-06-12' });
    expect(bars.map((b) => b.time)).toEqual(['2024-06-11', '2024-06-10']);
  });
});

describe('quotes and instrument patches', () => {
  it('never blanks stored optional fields with missing values', async () => {
    const base = {
      instrumentId,
      businessDate: '2024-06-10',
      lastTradedPrice: 100,
      previousClose: 99,
      totalTradedQty: 10n,
      totalTrades: 1,
      fiftyTwoWeekHigh: 150,
      fiftyTwoWeekLow: 80,
      sourceUpdatedAt: new Date(),
      marketOpen: false,
      fetchedAt: new Date(),
    };
    await ingestionRepo.writeBatch({ candles: [], quotes: [base], patches: [{ instrumentId, name: 'Test Co', sector: 'Banks', lastSyncedAt: new Date() }] });
    await ingestionRepo.writeBatch({
      candles: [],
      quotes: [{ ...base, lastTradedPrice: 101, fiftyTwoWeekHigh: null, previousClose: null }],
      patches: [{ instrumentId, lastSyncedAt: new Date() }],
    });
    const q = await prisma.quote.findUniqueOrThrow({ where: { instrumentId } });
    expect(q.lastTradedPrice.toString()).toBe('101');
    expect(q.fiftyTwoWeekHigh?.toString()).toBe('150');
    expect(q.previousClose?.toString()).toBe('99');
    const inst = await prisma.instrument.findUniqueOrThrow({ where: { id: instrumentId } });
    expect(inst).toMatchObject({ name: 'Test Co', sector: 'Banks' });
  });
});

describe('ingestion lock', () => {
  it('allows one holder, refuses others, and can be taken over only after expiry', async () => {
    expect(await ingestionRepo.acquireLock('L', 'a', 60_000)).toBe(true);
    expect(await ingestionRepo.acquireLock('L', 'b', 60_000)).toBe(false);
    expect(await ingestionRepo.extendLock('L', 'b', 60_000)).toBe(false);
    expect(await ingestionRepo.extendLock('L', 'a', 60_000)).toBe(true);

    await prisma.ingestionLock.update({ where: { name: 'L' }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await ingestionRepo.acquireLock('L', 'b', 60_000)).toBe(true);
    expect(await ingestionRepo.extendLock('L', 'a', 60_000)).toBe(false);

    await ingestionRepo.releaseLock('L', 'a'); // not the owner: no effect
    expect(await ingestionRepo.acquireLock('L', 'c', 60_000)).toBe(false);
    await ingestionRepo.releaseLock('L', 'b');
    expect(await ingestionRepo.acquireLock('L', 'c', 60_000)).toBe(true);
  });

  it('marks orphaned RUNNING runs as ABANDONED', async () => {
    const orphan = await ingestionRepo.createRun('SYNC', {}, 1);
    const current = await ingestionRepo.createRun('SYNC', {}, 1);
    expect(await ingestionRepo.abandonOrphanedRuns(current.id)).toBe(1);
    expect((await prisma.ingestionRun.findUniqueOrThrow({ where: { id: orphan.id } })).status).toBe('ABANDONED');
    expect((await prisma.ingestionRun.findUniqueOrThrow({ where: { id: current.id } })).status).toBe('RUNNING');
  });
});
