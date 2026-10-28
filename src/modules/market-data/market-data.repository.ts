import { prisma } from '../../config/prisma.js';
import { bigintToNumber, decimalToNumber } from '../../common/utils/serialize.js';
import { tradeDateFromDb, tradeDateToDb } from '../../common/utils/time.js';
import type { DailyBar } from './market-data.types.js';

/**
 * Daily bars in [fromInclusive, beforeExclusive), newest first, at most `take`.
 * Uses the (instrument_id, trade_date) unique index.
 */
export async function findDailyBarsDesc(params: {
  instrumentId: number;
  fromInclusive?: string;
  beforeExclusive?: string;
  take?: number;
}): Promise<DailyBar[]> {
  const rows = await prisma.dailyCandle.findMany({
    where: {
      instrumentId: params.instrumentId,
      tradeDate: {
        ...(params.fromInclusive ? { gte: tradeDateToDb(params.fromInclusive) } : {}),
        ...(params.beforeExclusive ? { lt: tradeDateToDb(params.beforeExclusive) } : {}),
      },
    },
    orderBy: { tradeDate: 'desc' },
    ...(params.take ? { take: params.take } : {}),
    select: { tradeDate: true, open: true, high: true, low: true, close: true, volume: true, isProvisional: true },
  });
  return rows.map((r) => ({
    time: tradeDateFromDb(r.tradeDate),
    open: decimalToNumber(r.open),
    high: decimalToNumber(r.high),
    low: decimalToNumber(r.low),
    close: decimalToNumber(r.close),
    volume: bigintToNumber(r.volume),
    provisional: r.isProvisional,
  }));
}

export async function hasAnyCandle(instrumentId: number): Promise<boolean> {
  const row = await prisma.dailyCandle.findFirst({ where: { instrumentId }, select: { id: true } });
  return row !== null;
}

export function findQuote(instrumentId: number) {
  return prisma.quote.findUnique({ where: { instrumentId } });
}

export async function lastSuccessfulSyncAt(): Promise<Date | null> {
  const run = await prisma.ingestionRun.findFirst({
    where: { type: 'SYNC', status: { in: ['SUCCEEDED', 'PARTIAL'] } },
    orderBy: { finishedAt: 'desc' },
    select: { finishedAt: true },
  });
  return run?.finishedAt ?? null;
}
