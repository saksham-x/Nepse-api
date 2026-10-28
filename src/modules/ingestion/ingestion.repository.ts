import { Prisma, type IngestionRunStatus, type IngestionRunType } from '@prisma/client';
import { prisma } from '../../config/prisma.js';
import { decimalToNumber } from '../../common/utils/serialize.js';
import { tradeDateFromDb, tradeDateToDb } from '../../common/utils/time.js';
import type { StoredCandle } from './ingestion.rules.js';
import type { InstrumentPatch, NormalizedCandle, NormalizedQuote } from './ingestion.types.js';

export interface InstrumentRef {
  id: number;
  symbol: string;
  nepseSecurityId: number;
}

export function listActiveInstruments(symbols?: readonly string[]): Promise<InstrumentRef[]> {
  return prisma.instrument.findMany({
    where: { isActive: true, ...(symbols?.length ? { symbol: { in: [...symbols] } } : {}) },
    select: { id: true, symbol: true, nepseSecurityId: true },
    orderBy: { symbol: 'asc' },
  });
}

export async function findInstrumentsBySymbols(symbols: readonly string[]): Promise<Map<string, InstrumentRef>> {
  const rows = await prisma.instrument.findMany({
    where: { symbol: { in: [...symbols] } },
    select: { id: true, symbol: true, nepseSecurityId: true },
  });
  return new Map(rows.map((r) => [r.symbol, r]));
}

/** Instruments that already have a final (non-provisional) candle for `tradeDate`. */
export async function instrumentsWithFinalCandle(instrumentIds: readonly number[], tradeDate: string): Promise<Set<number>> {
  if (instrumentIds.length === 0) return new Set();
  const rows = await prisma.dailyCandle.findMany({
    where: { instrumentId: { in: [...instrumentIds] }, tradeDate: tradeDateToDb(tradeDate), isProvisional: false },
    select: { instrumentId: true },
  });
  return new Set(rows.map((r) => r.instrumentId));
}

/** Stored candles keyed by instrument id, then trade date. */
export async function getStoredCandles(
  keys: readonly { instrumentId: number; tradeDate: string }[],
): Promise<Map<number, Map<string, StoredCandle>>> {
  const out = new Map<number, Map<string, StoredCandle>>();
  if (keys.length === 0) return out;

  const byInstrument = new Map<number, Date[]>();
  for (const k of keys) {
    const list = byInstrument.get(k.instrumentId) ?? [];
    list.push(tradeDateToDb(k.tradeDate));
    byInstrument.set(k.instrumentId, list);
  }
  const rows = await prisma.dailyCandle.findMany({
    where: { OR: [...byInstrument].map(([instrumentId, dates]) => ({ instrumentId, tradeDate: { in: dates } })) },
    select: { instrumentId: true, tradeDate: true, open: true, high: true, low: true, close: true, volume: true, trades: true, isProvisional: true },
  });
  for (const r of rows) {
    const map = out.get(r.instrumentId) ?? new Map<string, StoredCandle>();
    const tradeDate = tradeDateFromDb(r.tradeDate);
    map.set(tradeDate, {
      tradeDate,
      open: decimalToNumber(r.open),
      high: decimalToNumber(r.high),
      low: decimalToNumber(r.low),
      close: decimalToNumber(r.close),
      volume: r.volume,
      trades: r.trades,
      isProvisional: r.isProvisional,
    });
    out.set(r.instrumentId, map);
  }
  return out;
}

const fixed4 = (n: number) => n.toFixed(4);

function upsertCandlesSql(candles: readonly NormalizedCandle[], now: Date): Prisma.Sql {
  const values = candles.map(
    (c) => Prisma.sql`(${c.instrumentId}, ${c.tradeDate}, ${fixed4(c.open)}, ${fixed4(c.high)}, ${fixed4(c.low)}, ${fixed4(c.close)}, ${c.volume}, ${c.trades}, ${c.isProvisional}, ${c.source}, ${now}, ${now})`,
  );
  // `trades` keeps the stored value when the source did not supply one.
  return Prisma.sql`
    INSERT INTO \`daily_candles\`
      (\`instrument_id\`, \`trade_date\`, \`open\`, \`high\`, \`low\`, \`close\`, \`volume\`, \`trades\`, \`is_provisional\`, \`source\`, \`created_at\`, \`updated_at\`)
    VALUES ${Prisma.join(values)}
    AS new
    ON DUPLICATE KEY UPDATE
      \`open\` = new.\`open\`,
      \`high\` = new.\`high\`,
      \`low\` = new.\`low\`,
      \`close\` = new.\`close\`,
      \`volume\` = new.\`volume\`,
      \`trades\` = COALESCE(new.\`trades\`, \`daily_candles\`.\`trades\`),
      \`is_provisional\` = new.\`is_provisional\`,
      \`source\` = new.\`source\`,
      \`updated_at\` = new.\`updated_at\``;
}

function upsertQuote(q: NormalizedQuote) {
  const data = {
    businessDate: tradeDateToDb(q.businessDate),
    lastTradedPrice: q.lastTradedPrice,
    previousClose: q.previousClose,
    totalTradedQty: q.totalTradedQty,
    totalTrades: q.totalTrades,
    fiftyTwoWeekHigh: q.fiftyTwoWeekHigh,
    fiftyTwoWeekLow: q.fiftyTwoWeekLow,
    sourceUpdatedAt: q.sourceUpdatedAt,
    marketOpen: q.marketOpen,
    fetchedAt: q.fetchedAt,
  };
  // Missing optional fields never blank previously stored values.
  const update = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== null));
  return prisma.quote.upsert({ where: { instrumentId: q.instrumentId }, create: { instrumentId: q.instrumentId, ...data }, update });
}

function applyPatch(p: InstrumentPatch) {
  return prisma.instrument.update({
    where: { id: p.instrumentId },
    data: {
      lastSyncedAt: p.lastSyncedAt,
      ...(p.name ? { name: p.name } : {}),
      ...(p.sector ? { sector: p.sector } : {}),
      ...(p.instrumentType ? { instrumentType: p.instrumentType } : {}),
    },
  });
}

/** Writes a batch of already-fetched data atomically. No network I/O happens inside. */
export async function writeBatch(batch: {
  candles: readonly NormalizedCandle[];
  quotes: readonly NormalizedQuote[];
  patches: readonly InstrumentPatch[];
}): Promise<void> {
  const now = new Date();
  const ops: Prisma.PrismaPromise<unknown>[] = [];
  if (batch.candles.length > 0) ops.push(prisma.$executeRaw(upsertCandlesSql(batch.candles, now)));
  ops.push(...batch.quotes.map(upsertQuote), ...batch.patches.map(applyPatch));
  if (ops.length > 0) await prisma.$transaction(ops);
}

// ---------------------------------------------------------------------------
// Runs and locking
// ---------------------------------------------------------------------------

export interface RunCounts {
  requested: number;
  processed: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
  failed: number;
}

export function createRun(type: IngestionRunType, params: Prisma.InputJsonValue, requested: number) {
  return prisma.ingestionRun.create({ data: { type, status: 'RUNNING', params, requested } });
}

export function heartbeatRun(id: number, counts: RunCounts) {
  return prisma.ingestionRun.update({ where: { id }, data: { ...counts, heartbeatAt: new Date() } });
}

export function finishRun(
  id: number,
  status: IngestionRunStatus,
  counts: RunCounts,
  details: Prisma.InputJsonValue,
  errorMessage?: string,
) {
  return prisma.ingestionRun.update({
    where: { id },
    data: { ...counts, status, details, errorMessage: errorMessage ?? null, finishedAt: new Date(), heartbeatAt: new Date() },
  });
}

/**
 * Marks RUNNING runs that are not `exceptId` as ABANDONED. Only called while
 * holding the ingestion lock, so any other RUNNING row belongs to a dead process.
 */
export async function abandonOrphanedRuns(exceptId: number): Promise<number> {
  const res = await prisma.ingestionRun.updateMany({
    where: { status: 'RUNNING', id: { not: exceptId } },
    data: { status: 'ABANDONED', finishedAt: new Date(), errorMessage: 'process stopped before the run finished' },
  });
  return res.count;
}

export async function acquireLock(name: string, owner: string, ttlMs: number): Promise<boolean> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  try {
    await prisma.ingestionLock.create({ data: { name, owner, acquiredAt: now, expiresAt } });
    return true;
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
  }
  // Take over only an expired lock; the conditional update is atomic.
  const res = await prisma.ingestionLock.updateMany({
    where: { name, expiresAt: { lt: now } },
    data: { owner, acquiredAt: now, expiresAt },
  });
  return res.count === 1;
}

export async function extendLock(name: string, owner: string, ttlMs: number): Promise<boolean> {
  const res = await prisma.ingestionLock.updateMany({
    where: { name, owner },
    data: { expiresAt: new Date(Date.now() + ttlMs) },
  });
  return res.count === 1;
}

export async function releaseLock(name: string, owner: string): Promise<void> {
  await prisma.ingestionLock.deleteMany({ where: { name, owner } });
}
