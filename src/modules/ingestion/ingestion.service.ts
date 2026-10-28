import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { IngestionRunStatus, IngestionRunType, Prisma } from '@prisma/client';
import { env } from '../../config/env.js';
import { logger as rootLogger, type Logger } from '../../config/logger.js';
import { forEachLimit } from '../../common/utils/concurrency.js';
import { kathmanduDate } from '../../common/utils/time.js';
import { parseCsv, parseCsvDate, parseCsvNumber, resolveColumns } from './csv.js';
import * as repo from './ingestion.repository.js';
import { checkCandle, diffCandles } from './ingestion.rules.js';
import type { InstrumentPatch, NormalizedCandle, NormalizedQuote, SkippedRecord } from './ingestion.types.js';
import { mapSecurityDetail } from './providers/nepse.mapper.js';
import { getNepseProvider } from './providers/nepse.provider.js';
import { ProviderError } from './providers/provider-error.js';
import type { MarketStatus } from './providers/nepse.types.js';

const LOCK_NAME = 'market-data-ingestion';
const MAX_DETAIL_ENTRIES = 200;

export class IngestionLockedError extends Error {
  constructor() {
    super('Another ingestion run is in progress');
    this.name = 'IngestionLockedError';
  }
}

/** The subset of NepseProvider the service needs; lets tests pass a fake. */
export interface MarketDataProvider {
  getMarketStatus(): Promise<MarketStatus>;
  getSecurityDetail(securityId: number): Promise<{ data: unknown; marketStatus: MarketStatus }>;
}

export interface IngestionDeps {
  provider: MarketDataProvider;
  logger: Logger;
  now: () => Date;
  config: {
    concurrency: number;
    batchSize: number;
    maxConsecutiveFailures: number;
    lockTtlMs: number;
    defaultSymbols: readonly string[];
  };
}

export interface Failure {
  symbol: string;
  kind: string;
  message: string;
}

export interface IngestionSummary {
  runId: number | null;
  type: IngestionRunType;
  status: IngestionRunStatus;
  counts: repo.RunCounts;
  skipped: SkippedRecord[];
  failures: Failure[];
  notes: string[];
  durationMs: number;
}

export interface SyncOptions {
  /** Limit to these symbols; defaults to SYNC_SYMBOLS, then all active instruments. */
  symbols?: readonly string[];
  /** Refetch instruments that already have a final candle for the latest session. */
  force?: boolean;
  signal?: AbortSignal;
}

export interface BackfillOptions {
  filePath: string;
  symbols?: readonly string[];
  from?: string;
  to?: string;
  /** Replace stored candles whose values differ. Default false: report them as conflicts. */
  overwrite?: boolean;
  dryRun?: boolean;
}

const emptyCounts = (requested = 0): repo.RunCounts => ({
  requested,
  processed: 0,
  inserted: 0,
  updated: 0,
  unchanged: 0,
  skipped: 0,
  failed: 0,
});

/** Keeps the first N entries for the run record while still counting all of them. */
function capped<T>(list: T[], item: T): void {
  if (list.length < MAX_DETAIL_ENTRIES) list.push(item);
}

interface FetchedItem {
  symbol: string;
  candle: NormalizedCandle | null;
  quote: NormalizedQuote | null;
  patch: InstrumentPatch | null;
}

export function createIngestionService(deps: IngestionDeps) {
  const log = deps.logger.child({ module: 'ingestion' });

  /** Diffs fetched candles against storage and writes candles, quotes and patches in one transaction. */
  async function persist(items: readonly FetchedItem[], counts: repo.RunCounts, skipped: SkippedRecord[], overwrite: boolean) {
    const candles = items.flatMap((i) => (i.candle ? [{ symbol: i.symbol, candle: i.candle }] : []));
    const stored = await repo.getStoredCandles(candles.map((c) => c.candle));

    const toWrite: NormalizedCandle[] = [];
    for (const { symbol, candle } of candles) {
      const diff = diffCandles(stored.get(candle.instrumentId) ?? new Map(), [candle], { overwrite, symbol });
      toWrite.push(...diff.toWrite);
      counts.inserted += diff.inserted;
      counts.updated += diff.updated;
      counts.unchanged += diff.unchanged;
      counts.skipped += diff.skipped.length;
      diff.skipped.forEach((s) => capped(skipped, s));
    }

    await repo.writeBatch({
      candles: toWrite,
      quotes: items.flatMap((i) => (i.quote ? [i.quote] : [])),
      patches: items.flatMap((i) => (i.patch ? [i.patch] : [])),
    });
  }

  async function withLock<T>(fn: (owner: string) => Promise<T>): Promise<T> {
    const owner = randomUUID();
    if (!(await repo.acquireLock(LOCK_NAME, owner, deps.config.lockTtlMs))) throw new IngestionLockedError();
    try {
      return await fn(owner);
    } finally {
      await repo.releaseLock(LOCK_NAME, owner).catch((err) => log.error({ err }, 'failed to release ingestion lock'));
    }
  }

  async function keepAlive(owner: string, runId: number, counts: repo.RunCounts) {
    if (!(await repo.extendLock(LOCK_NAME, owner, deps.config.lockTtlMs))) {
      throw new Error('Lost the ingestion lock (it expired and was taken over); stopping this run');
    }
    await repo.heartbeatRun(runId, counts);
  }

  async function runSync(options: SyncOptions = {}): Promise<IngestionSummary> {
    const startedAt = Date.now();
    const requestedSymbols = options.symbols?.length ? options.symbols : deps.config.defaultSymbols;

    return withLock(async (owner) => {
      const instruments = await repo.listActiveInstruments(requestedSymbols);
      const counts = emptyCounts(instruments.length);
      const skipped: SkippedRecord[] = [];
      const failures: Failure[] = [];
      const notes: string[] = [];

      const known = new Set(instruments.map((i) => i.symbol));
      for (const symbol of requestedSymbols.filter((s) => !known.has(s))) {
        counts.skipped++;
        capped(skipped, { symbol, reason: 'UNKNOWN_SYMBOL', message: 'not an active instrument; run `npm run db:seed`?' });
      }

      const params = { symbols: requestedSymbols.length ? [...requestedSymbols] : 'ALL', force: !!options.force } satisfies Prisma.InputJsonValue;
      const run = await repo.createRun('SYNC', params, instruments.length);
      const runLog = log.child({ runId: run.id, type: 'SYNC' });
      const abandoned = await repo.abandonOrphanedRuns(run.id);
      if (abandoned > 0) notes.push(`marked ${abandoned} interrupted run(s) as ABANDONED`);
      runLog.info({ instruments: instruments.length }, 'sync started');

      const finish = async (status: IngestionRunStatus, errorMessage?: string): Promise<IngestionSummary> => {
        await repo.finishRun(run.id, status, counts, { skipped, failures, notes } as unknown as Prisma.InputJsonValue, errorMessage);
        const summary = { runId: run.id, type: 'SYNC' as const, status, counts, skipped, failures, notes, durationMs: Date.now() - startedAt };
        runLog.info({ status, counts, failures: failures.length, durationMs: summary.durationMs }, 'sync finished');
        return summary;
      };

      try {
        let marketStatus: MarketStatus;
        try {
          marketStatus = await deps.provider.getMarketStatus();
        } catch (err) {
          if (!(err instanceof ProviderError)) throw err;
          return await finish('FAILED', `could not start a provider session: ${err.message}`);
        }

        // Incremental: once a session has closed, instruments with a final candle for it are done.
        let targets = instruments;
        if (!options.force && !marketStatus.isOpen && marketStatus.asOfDate) {
          const done = await repo.instrumentsWithFinalCandle(instruments.map((i) => i.id), marketStatus.asOfDate);
          targets = instruments.filter((i) => !done.has(i.id));
          if (done.size > 0) {
            counts.unchanged += done.size;
            notes.push(`${done.size} instrument(s) already final for ${marketStatus.asOfDate}; use --force to refetch`);
          }
        }

        let buffer: FetchedItem[] = [];
        let flushChain = Promise.resolve();
        let consecutiveFailures = 0;
        let abortReason: string | null = null;

        const flush = () => {
          const items = buffer;
          buffer = [];
          flushChain = flushChain.then(async () => {
            if (items.length > 0) await persist(items, counts, skipped, true);
            await keepAlive(owner, run.id, counts);
          });
          return flushChain;
        };

        await forEachLimit(
          targets,
          deps.config.concurrency,
          async (inst) => {
            const fetchedAt = deps.now();
            try {
              const { data, marketStatus: ms } = await deps.provider.getSecurityDetail(inst.nepseSecurityId);
              consecutiveFailures = 0;
              const mapped = mapSecurityDetail(data, { instrumentId: inst.id, symbol: inst.symbol, marketStatus: ms, fetchedAt, today: kathmanduDate(fetchedAt) });
              counts.processed++;
              counts.skipped += mapped.skipped.length;
              mapped.skipped.forEach((s) => capped(skipped, s));
              buffer.push({ symbol: inst.symbol, ...mapped });
            } catch (err) {
              if (!(err instanceof ProviderError)) throw err;
              counts.failed++;
              consecutiveFailures++;
              capped(failures, { symbol: inst.symbol, kind: err.kind, message: err.message });
              runLog.warn({ symbol: inst.symbol, kind: err.kind, status: err.meta.status }, 'security fetch failed');
              if (consecutiveFailures >= deps.config.maxConsecutiveFailures) {
                abortReason ??= `aborted after ${consecutiveFailures} consecutive provider failures (last: ${err.message})`;
              }
            }
            if (buffer.length >= deps.config.batchSize) await flush();
          },
          () => abortReason !== null || !!options.signal?.aborted,
        );
        await flush();

        if (options.signal?.aborted) abortReason ??= 'stopped by shutdown signal';
        const anySuccess = counts.processed > 0 || targets.length === 0;
        if (abortReason) return await finish(anySuccess ? 'PARTIAL' : 'FAILED', abortReason);
        if (counts.failed > 0) return await finish(anySuccess ? 'PARTIAL' : 'FAILED', `${counts.failed} instrument(s) failed`);
        return await finish('SUCCEEDED');
      } catch (err) {
        runLog.error({ err }, 'sync crashed');
        await finish('FAILED', (err as Error).message).catch((e) => runLog.error({ err: e }, 'could not record failed run'));
        throw err;
      }
    });
  }

  async function runBackfill(options: BackfillOptions): Promise<IngestionSummary> {
    const startedAt = Date.now();
    const text = await readFile(options.filePath, 'utf8');
    const { header, rows } = parseCsv(text);
    const cols = resolveColumns(header);
    const today = kathmanduDate(deps.now());
    const symbolFilter = options.symbols?.length ? new Set(options.symbols) : null;

    const counts = emptyCounts(rows.length);
    const skipped: SkippedRecord[] = [];
    const notes: string[] = [];
    const skip = (s: SkippedRecord) => {
      counts.skipped++;
      capped(skipped, s);
    };

    const candidates: { symbol: string; line: number; tradeDate: string; values: Record<string, string> }[] = [];
    let filtered = 0;
    for (const row of rows) {
      const symbol = row.values[cols.symbol!]?.toUpperCase() ?? '';
      const tradeDate = parseCsvDate(row.values[cols.date!]);
      if (!tradeDate) {
        skip({ symbol, line: row.line, reason: 'INVALID_DATE', message: `invalid date '${row.values[cols.date!]}' (expected YYYY-MM-DD)` });
        continue;
      }
      if ((symbolFilter && !symbolFilter.has(symbol)) || (options.from && tradeDate < options.from) || (options.to && tradeDate > options.to)) {
        filtered++;
        continue;
      }
      candidates.push({ symbol, line: row.line, tradeDate, values: row.values });
    }
    if (filtered > 0) notes.push(`${filtered} row(s) outside the requested symbols/date range were ignored`);

    const instruments = await repo.findInstrumentsBySymbols([...new Set(candidates.map((c) => c.symbol))]);
    const seen = new Set<string>();
    const candles: { symbol: string; candle: NormalizedCandle }[] = [];
    for (const c of candidates) {
      const inst = instruments.get(c.symbol);
      if (!inst) {
        skip({ symbol: c.symbol, line: c.line, tradeDate: c.tradeDate, reason: 'UNKNOWN_SYMBOL', message: 'symbol is not in the instruments table' });
        continue;
      }
      const key = `${inst.id}|${c.tradeDate}`;
      if (seen.has(key)) {
        skip({ symbol: c.symbol, line: c.line, tradeDate: c.tradeDate, reason: 'DUPLICATE_IN_INPUT', message: 'an earlier row has the same symbol and date' });
        continue;
      }
      seen.add(key);
      const check = checkCandle(
        {
          tradeDate: c.tradeDate,
          open: parseCsvNumber(c.values[cols.open!]),
          high: parseCsvNumber(c.values[cols.high!]),
          low: parseCsvNumber(c.values[cols.low!]),
          close: parseCsvNumber(c.values[cols.close!]),
          volume: parseCsvNumber(c.values[cols.volume!]),
        },
        today,
      );
      if (!check.ok) {
        skip({ symbol: c.symbol, line: c.line, tradeDate: c.tradeDate, reason: check.reason, message: check.message });
        continue;
      }
      const trades = cols.trades ? parseCsvNumber(c.values[cols.trades]) : null;
      candles.push({
        symbol: c.symbol,
        candle: {
          instrumentId: inst.id,
          tradeDate: c.tradeDate,
          open: check.open,
          high: check.high,
          low: check.low,
          close: check.close,
          volume: check.volume,
          trades: trades !== null && Number.isSafeInteger(trades) && trades >= 0 ? trades : null,
          isProvisional: false,
          source: 'CSV_IMPORT',
        },
      });
    }

    const processBatches = async (write: boolean, onBatch?: () => Promise<void>) => {
      for (let i = 0; i < candles.length; i += deps.config.batchSize) {
        const batch = candles.slice(i, i + deps.config.batchSize);
        const stored = await repo.getStoredCandles(batch.map((b) => b.candle));
        const toWrite: NormalizedCandle[] = [];
        for (const { symbol, candle } of batch) {
          const diff = diffCandles(stored.get(candle.instrumentId) ?? new Map(), [candle], { overwrite: !!options.overwrite, symbol });
          toWrite.push(...diff.toWrite);
          counts.inserted += diff.inserted;
          counts.updated += diff.updated;
          counts.unchanged += diff.unchanged;
          diff.skipped.forEach(skip);
        }
        counts.processed += batch.length;
        if (write && toWrite.length > 0) await repo.writeBatch({ candles: toWrite, quotes: [], patches: [] });
        await onBatch?.();
      }
    };

    if (options.dryRun) {
      await processBatches(false);
      notes.push('dry run: nothing was written');
      return { runId: null, type: 'BACKFILL', status: 'SUCCEEDED', counts, skipped, failures: [], notes, durationMs: Date.now() - startedAt };
    }

    return withLock(async (owner) => {
      const params = { file: options.filePath, symbols: options.symbols ?? 'ALL', from: options.from ?? null, to: options.to ?? null, overwrite: !!options.overwrite };
      const run = await repo.createRun('BACKFILL', params as Prisma.InputJsonValue, rows.length);
      const abandoned = await repo.abandonOrphanedRuns(run.id);
      if (abandoned > 0) notes.push(`marked ${abandoned} interrupted run(s) as ABANDONED`);
      const details = () => ({ skipped, notes }) as unknown as Prisma.InputJsonValue;
      try {
        await processBatches(true, () => keepAlive(owner, run.id, counts));
        const status: IngestionRunStatus = 'SUCCEEDED';
        await repo.finishRun(run.id, status, counts, details());
        log.info({ runId: run.id, counts }, 'backfill finished');
        return { runId: run.id, type: 'BACKFILL' as const, status, counts, skipped, failures: [], notes, durationMs: Date.now() - startedAt };
      } catch (err) {
        await repo.finishRun(run.id, 'FAILED', counts, details(), (err as Error).message).catch(() => undefined);
        throw err;
      }
    });
  }

  const inFlightRefresh = new Map<string, Promise<void>>();

  /**
   * Fetches one instrument's latest snapshot and stores it. Concurrent calls for
   * the same symbol share one upstream request. Throws ProviderError on failure.
   */
  function refreshInstrument(inst: repo.InstrumentRef): Promise<void> {
    const existing = inFlightRefresh.get(inst.symbol);
    if (existing) return existing;

    const task = (async () => {
      const fetchedAt = deps.now();
      const { data, marketStatus } = await deps.provider.getSecurityDetail(inst.nepseSecurityId);
      const mapped = mapSecurityDetail(data, { instrumentId: inst.id, symbol: inst.symbol, marketStatus, fetchedAt, today: kathmanduDate(fetchedAt) });
      if (!mapped.quote) {
        const reason = mapped.skipped[0];
        throw new ProviderError('invalid_response', `no usable quote for ${inst.symbol}: ${reason?.reason ?? 'unknown'} ${reason?.message ?? ''}`.trim());
      }
      await persist([{ symbol: inst.symbol, ...mapped }], emptyCounts(), [], true);
    })().finally(() => inFlightRefresh.delete(inst.symbol));

    inFlightRefresh.set(inst.symbol, task);
    return task;
  }

  return { runSync, runBackfill, refreshInstrument };
}

export type IngestionService = ReturnType<typeof createIngestionService>;

let defaultService: IngestionService | undefined;

export function getIngestionService(): IngestionService {
  defaultService ??= createIngestionService({
    provider: getNepseProvider(),
    logger: rootLogger,
    now: () => new Date(),
    config: {
      concurrency: env.SYNC_CONCURRENCY,
      batchSize: env.SYNC_BATCH_SIZE,
      maxConsecutiveFailures: env.SYNC_MAX_CONSECUTIVE_FAILURES,
      lockTtlMs: env.INGESTION_LOCK_TTL_SECONDS * 1000,
      defaultSymbols: env.SYNC_SYMBOLS,
    },
  });
  return defaultService;
}
