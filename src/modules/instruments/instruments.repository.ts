import { prisma } from '../../config/prisma.js';

export function findBySymbol(symbol: string) {
  return prisma.instrument.findUnique({ where: { symbol } });
}

/** Case-insensitive (MySQL default collation) match on symbol prefix or name substring. */
export function search(term: string | undefined, take: number) {
  return prisma.instrument.findMany({
    where: {
      isActive: true,
      ...(term ? { OR: [{ symbol: { startsWith: term } }, { name: { contains: term } }] } : {}),
    },
    orderBy: { symbol: 'asc' },
    // Over-fetch so exact/prefix symbol matches can be ranked first in the service.
    take: term ? Math.min(take * 5, 250) : take,
  });
}

export async function candleCoverage(instrumentId: number) {
  const agg = await prisma.dailyCandle.aggregate({
    where: { instrumentId },
    _min: { tradeDate: true },
    _max: { tradeDate: true },
    _count: { _all: true },
  });
  return { first: agg._min.tradeDate, last: agg._max.tradeDate, count: agg._count._all };
}
