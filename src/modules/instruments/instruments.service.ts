import type { Instrument } from '@prisma/client';
import { AppError, ErrorCode } from '../../common/errors/app-error.js';
import { tradeDateFromDb } from '../../common/utils/time.js';
import * as repo from './instruments.repository.js';

export interface InstrumentSummary {
  symbol: string;
  name: string | null;
  sector: string | null;
  instrumentType: string | null;
}

const toSummary = (i: Instrument): InstrumentSummary => ({
  symbol: i.symbol,
  name: i.name,
  sector: i.sector,
  instrumentType: i.instrumentType,
});

export async function requireInstrument(symbol: string): Promise<Instrument> {
  const instrument = await repo.findBySymbol(symbol);
  if (!instrument) {
    throw AppError.notFound(ErrorCode.INSTRUMENT_NOT_FOUND, `Unknown symbol '${symbol}'`, { symbol });
  }
  return instrument;
}

export async function searchInstruments(term: string | undefined, limit: number): Promise<InstrumentSummary[]> {
  const upper = term?.toUpperCase();
  const rows = await repo.search(term, limit);
  const rank = (i: Instrument) => (!upper ? 0 : i.symbol === upper ? 0 : i.symbol.startsWith(upper) ? 1 : 2);
  return rows
    .sort((a, b) => rank(a) - rank(b) || a.symbol.localeCompare(b.symbol))
    .slice(0, limit)
    .map(toSummary);
}

export async function getInstrumentDetails(symbol: string) {
  const instrument = await requireInstrument(symbol);
  const coverage = await repo.candleCoverage(instrument.id);
  return {
    ...toSummary(instrument),
    isActive: instrument.isActive,
    lastSyncedAt: instrument.lastSyncedAt?.toISOString() ?? null,
    dailyCandles: {
      count: coverage.count,
      firstDate: coverage.first ? tradeDateFromDb(coverage.first) : null,
      lastDate: coverage.last ? tradeDateFromDb(coverage.last) : null,
    },
    supportedIntervals: ['1d', '1w', '1mo'],
  };
}
