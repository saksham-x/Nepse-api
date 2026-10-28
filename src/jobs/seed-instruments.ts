/**
 * Upserts the symbol -> security id map into the instruments table. Idempotent.
 * Names/sectors are filled in later by `npm run sync` from provider responses.
 *
 *   npm run db:seed
 */
import { logger } from '../config/logger.js';
import { prisma } from '../config/prisma.js';
import { NEPSE_SECURITIES } from '../modules/ingestion/providers/nepse.securities.js';

async function main(): Promise<void> {
  const existing = await prisma.instrument.findMany({ select: { id: true, symbol: true, nepseSecurityId: true } });
  const bySymbol = new Map(existing.map((i) => [i.symbol, i]));

  const toCreate = Object.entries(NEPSE_SECURITIES)
    .filter(([symbol]) => !bySymbol.has(symbol))
    .map(([symbol, nepseSecurityId]) => ({ symbol, nepseSecurityId }));
  const toUpdate = Object.entries(NEPSE_SECURITIES).filter(([symbol, id]) => {
    const row = bySymbol.get(symbol);
    return row !== undefined && row.nepseSecurityId !== id;
  });

  await prisma.$transaction([
    prisma.instrument.createMany({ data: toCreate }),
    ...toUpdate.map(([symbol, nepseSecurityId]) => prisma.instrument.update({ where: { symbol }, data: { nepseSecurityId } })),
  ]);
  logger.info({ created: toCreate.length, updated: toUpdate.length, total: Object.keys(NEPSE_SECURITIES).length }, 'instruments seeded');
}

try {
  await main();
} catch (err) {
  logger.error({ err }, 'seeding failed');
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
