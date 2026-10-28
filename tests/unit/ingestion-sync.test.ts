import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import type { NormalizedCandle, NormalizedQuote } from '../../src/modules/ingestion/ingestion.types.js';
import type { MarketStatus } from '../../src/modules/ingestion/providers/nepse.types.js';
import { securityDetail } from '../fixtures/security-detail.js';

/** In-memory stand-in for ingestion.repository with the same contract. */
const db = vi.hoisted(() => ({
  instruments: [] as { id: number; symbol: string; nepseSecurityId: number }[],
  candles: new Map<string, NormalizedCandle>(),
  quotes: new Map<number, NormalizedQuote>(),
  runs: new Map<number, { status: string; counts?: unknown; errorMessage?: string }>(),
  lockOwner: null as string | null,
  writes: 0,
}));

vi.mock('../../src/modules/ingestion/ingestion.repository.js', () => ({
  listActiveInstruments: async (symbols?: string[]) => db.instruments.filter((i) => !symbols?.length || symbols.includes(i.symbol)),
  findInstrumentsBySymbols: async (symbols: string[]) => new Map(db.instruments.filter((i) => symbols.includes(i.symbol)).map((i) => [i.symbol, i])),
  instrumentsWithFinalCandle: async (ids: number[], date: string) =>
    new Set(ids.filter((id) => db.candles.get(`${id}|${date}`)?.isProvisional === false)),
  getStoredCandles: async (keys: { instrumentId: number; tradeDate: string }[]) => {
    const out = new Map<number, Map<string, NormalizedCandle>>();
    for (const k of keys) {
      const c = db.candles.get(`${k.instrumentId}|${k.tradeDate}`);
      if (c) out.set(k.instrumentId, (out.get(k.instrumentId) ?? new Map()).set(k.tradeDate, c));
    }
    return out;
  },
  writeBatch: async (batch: { candles: NormalizedCandle[]; quotes: NormalizedQuote[] }) => {
    db.writes++;
    for (const c of batch.candles) db.candles.set(`${c.instrumentId}|${c.tradeDate}`, c);
    for (const q of batch.quotes) db.quotes.set(q.instrumentId, q);
  },
  createRun: async () => {
    const id = db.runs.size + 1;
    db.runs.set(id, { status: 'RUNNING' });
    return { id };
  },
  heartbeatRun: async () => undefined,
  finishRun: async (id: number, status: string, counts: unknown, _details: unknown, errorMessage?: string) => {
    db.runs.set(id, { status, counts, errorMessage });
  },
  abandonOrphanedRuns: async () => 0,
  acquireLock: async (_name: string, owner: string) => {
    if (db.lockOwner) return false;
    db.lockOwner = owner;
    return true;
  },
  extendLock: async (_name: string, owner: string) => db.lockOwner === owner,
  releaseLock: async (_name: string, owner: string) => {
    if (db.lockOwner === owner) db.lockOwner = null;
  },
}));

const { createIngestionService, IngestionLockedError } = await import('../../src/modules/ingestion/ingestion.service.js');
const { ProviderError } = await import('../../src/modules/ingestion/providers/provider-error.js');

const closed: MarketStatus = { isOpen: false, rawStatus: 'CLOSE', asOf: new Date('2024-06-12T09:15:00Z'), asOfDate: '2024-06-12' };
const open: MarketStatus = { ...closed, isOpen: true, rawStatus: 'OPEN' };

const SYMBOLS = ['ADBL', 'HRL', 'NABIL'];

function service(opts: { market?: MarketStatus; detail?: (securityId: number) => unknown } = {}) {
  const market = opts.market ?? closed;
  const provider = {
    getMarketStatus: vi.fn(async () => market),
    getSecurityDetail: vi.fn(async (securityId: number) => {
      const inst = db.instruments.find((i) => i.nepseSecurityId === securityId)!;
      const data = opts.detail ? opts.detail(securityId) : securityDetail({ security: { symbol: inst.symbol } });
      return { data, marketStatus: market };
    }),
  };
  const svc = createIngestionService({
    provider,
    logger: pino({ level: 'silent' }),
    now: () => new Date('2024-06-12T10:00:00Z'),
    config: { concurrency: 2, batchSize: 2, maxConsecutiveFailures: 3, lockTtlMs: 60_000, defaultSymbols: [] },
  });
  return { svc, provider };
}

beforeEach(() => {
  db.instruments = SYMBOLS.map((symbol, i) => ({ id: i + 1, symbol, nepseSecurityId: 100 + i }));
  db.candles.clear();
  db.quotes.clear();
  db.runs.clear();
  db.lockOwner = null;
  db.writes = 0;
});

describe('runSync', () => {
  it('stores a candle and quote per instrument and records a successful run', async () => {
    const { svc } = service();
    const summary = await svc.runSync();
    expect(summary.status).toBe('SUCCEEDED');
    expect(summary.counts).toMatchObject({ requested: 3, processed: 3, inserted: 3, updated: 0, failed: 0 });
    expect(db.candles.size).toBe(3);
    expect(db.quotes.size).toBe(3);
    expect(db.runs.get(summary.runId!)?.status).toBe('SUCCEEDED');
    expect(db.lockOwner).toBeNull();
  });

  it('is idempotent: re-running with --force writes no candle changes', async () => {
    await service().svc.runSync();
    const second = await service().svc.runSync({ force: true });
    expect(second.counts).toMatchObject({ inserted: 0, updated: 0, unchanged: 3 });
  });

  it('skips instruments already final for a closed session (incremental resume)', async () => {
    await service().svc.runSync({ symbols: ['ADBL'] });
    const { svc, provider } = service();
    const summary = await svc.runSync();
    expect(provider.getSecurityDetail).toHaveBeenCalledTimes(2);
    expect(summary.counts).toMatchObject({ inserted: 2, unchanged: 1 });
    expect(summary.notes.join()).toMatch(/already final/);
  });

  it('applies corrected values to a stored candle', async () => {
    await service().svc.runSync();
    const { svc } = service({ detail: (id) => securityDetail({ security: { symbol: db.instruments.find((i) => i.nepseSecurityId === id)!.symbol }, trade: { closePrice: 306, lastTradedPrice: 306 } }) });
    const summary = await svc.runSync({ force: true });
    expect(summary.counts).toMatchObject({ updated: 3, inserted: 0 });
    expect(db.candles.get('1|2024-06-12')?.close).toBe(306);
  });

  it('upgrades provisional candles to final once the session closes', async () => {
    await service({ market: open }).svc.runSync();
    expect(db.candles.get('1|2024-06-12')?.isProvisional).toBe(true);
    const summary = await service({ market: closed }).svc.runSync();
    expect(summary.counts.updated).toBe(3);
    expect(db.candles.get('1|2024-06-12')?.isProvisional).toBe(false);
  });

  it('reports skipped records and still stores what is valid', async () => {
    const { svc } = service({ detail: (id) => (id === 101 ? securityDetail({ security: { symbol: 'HRL' }, trade: { highPrice: 1 } }) : securityDetail({ security: { symbol: db.instruments.find((i) => i.nepseSecurityId === id)!.symbol } })) });
    const summary = await svc.runSync();
    expect(summary.status).toBe('SUCCEEDED');
    expect(summary.counts).toMatchObject({ inserted: 2, skipped: 1 });
    expect(summary.skipped[0]).toMatchObject({ symbol: 'HRL', reason: 'OHLC_INCONSISTENT' });
  });

  it('marks the run PARTIAL when some instruments fail upstream', async () => {
    const { svc, provider } = service();
    provider.getSecurityDetail.mockImplementationOnce(async () => {
      throw new ProviderError('timeout', 'timed out');
    });
    const summary = await svc.runSync();
    expect(summary.status).toBe('PARTIAL');
    expect(summary.counts).toMatchObject({ processed: 2, failed: 1 });
    expect(summary.failures[0]).toMatchObject({ kind: 'timeout' });
  });

  it('aborts after too many consecutive upstream failures', async () => {
    db.instruments = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, symbol: `S${i}`, nepseSecurityId: 100 + i }));
    const { svc, provider } = service();
    provider.getSecurityDetail.mockImplementation(async () => {
      throw new ProviderError('network', 'ECONNRESET');
    });
    const summary = await svc.runSync();
    expect(summary.status).toBe('FAILED');
    expect(provider.getSecurityDetail.mock.calls.length).toBeLessThan(10);
    expect(db.runs.get(summary.runId!)?.errorMessage).toMatch(/consecutive provider failures/);
  });

  it('fails the run cleanly when no provider session can be created', async () => {
    const { svc, provider } = service();
    provider.getMarketStatus.mockRejectedValueOnce(new ProviderError('network', 'ECONNREFUSED'));
    const summary = await svc.runSync();
    expect(summary.status).toBe('FAILED');
    expect(provider.getSecurityDetail).not.toHaveBeenCalled();
    expect(db.lockOwner).toBeNull();
  });

  it('refuses to start while another run holds the lock', async () => {
    db.lockOwner = 'someone-else';
    await expect(service().svc.runSync()).rejects.toBeInstanceOf(IngestionLockedError);
    expect(db.runs.size).toBe(0);
  });

  it('stops starting new work when signalled and records PARTIAL', async () => {
    const controller = new AbortController();
    const { svc, provider } = service();
    provider.getSecurityDetail.mockImplementation(async (securityId: number) => {
      controller.abort();
      const inst = db.instruments.find((i) => i.nepseSecurityId === securityId)!;
      return { data: securityDetail({ security: { symbol: inst.symbol } }), marketStatus: closed };
    });
    const summary = await svc.runSync({ signal: controller.signal });
    expect(summary.status).toBe('PARTIAL');
    expect(summary.counts.processed).toBeLessThan(3);
  });
});

describe('runBackfill', () => {
  const write = async (content: string) => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'nepse-backfill-'));
    const file = join(dir, 'history.csv');
    await writeFile(file, content);
    return file;
  };

  const CSV = [
    'symbol,date,open,high,low,close,volume',
    'ADBL,2024-06-10,300,310,295,305,"1,000"',
    'ADBL,2024-06-11,305,312,300,310,2000',
    'ADBL,2024-06-11,1,1,1,1,1',
    'ADBL,2024-06-12,305,300,300,310,2000',
    'UNKNOWN,2024-06-10,1,1,1,1,1',
    'HRL,06/10/2024,1,1,1,1,1',
  ].join('\n');

  it('imports valid rows and reports every rejected row with its line', async () => {
    const summary = await service().svc.runBackfill({ filePath: await write(CSV) });
    expect(summary.counts).toMatchObject({ inserted: 2, skipped: 4 });
    expect(summary.skipped.map((s) => [s.line, s.reason])).toEqual([
      [7, 'INVALID_DATE'],
      [4, 'DUPLICATE_IN_INPUT'],
      [5, 'OHLC_INCONSISTENT'],
      [6, 'UNKNOWN_SYMBOL'],
    ]);
    expect(db.candles.get('1|2024-06-10')).toMatchObject({ volume: 1000n, source: 'CSV_IMPORT', isProvisional: false });
  });

  it('does not overwrite differing stored candles unless asked to', async () => {
    await service().svc.runBackfill({ filePath: await write(CSV) });
    const corrected = await write('symbol,date,open,high,low,close,volume\nADBL,2024-06-10,300,310,295,306,1000\n');
    const noOverwrite = await service().svc.runBackfill({ filePath: corrected });
    expect(noOverwrite.counts).toMatchObject({ updated: 0, skipped: 1 });
    expect(db.candles.get('1|2024-06-10')?.close).toBe(305);

    const overwrite = await service().svc.runBackfill({ filePath: corrected, overwrite: true });
    expect(overwrite.counts.updated).toBe(1);
    expect(db.candles.get('1|2024-06-10')?.close).toBe(306);
  });

  it('writes nothing in dry-run mode', async () => {
    const summary = await service().svc.runBackfill({ filePath: await write(CSV), dryRun: true });
    expect(summary.counts.inserted).toBe(2);
    expect(db.writes).toBe(0);
    expect(db.runs.size).toBe(0);
  });

  it('filters by symbol and date range', async () => {
    const summary = await service().svc.runBackfill({ filePath: await write(CSV), symbols: ['ADBL'], from: '2024-06-11', to: '2024-06-11' });
    expect(summary.counts.inserted).toBe(1);
    expect([...db.candles.keys()]).toEqual(['1|2024-06-11']);
  });
});
