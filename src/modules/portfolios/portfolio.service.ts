import type { Holding, Portfolio, PortfolioTransaction, Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma.js';
import { kathmanduDate, tradeDateFromDb, tradeDateToDb } from '../../common/utils/time.js';
import { Dec, navPerUnit, replay, ZERO, type Decimal, type LedgerResult, type LedgerTx } from './ledger.js';

type Db = Prisma.TransactionClient;

export const num = (d: Decimal) => Number(d.toFixed(4));
export const num6 = (d: Decimal) => Number(d.toFixed(6));

/** Serializes writes that depend on NAV (deposits, exits, trades) for one portfolio. */
export async function lockPortfolio(db: Db, portfolioId: number): Promise<void> {
  await db.$queryRaw`SELECT id FROM portfolios WHERE id = ${portfolioId} FOR UPDATE`;
}

export const toLedgerTx = (t: PortfolioTransaction): LedgerTx => ({
  id: t.id,
  type: t.type,
  date: tradeDateFromDb(t.date),
  holdingId: t.holdingId,
  quantity: t.quantity,
  price: t.price,
  amount: t.amount,
  fees: t.fees,
});

export interface HoldingValue {
  holding: Holding;
  quantity: Decimal;
  cost: Decimal;
  avgCost: Decimal;
  marketValue: Decimal;
  unrealized: Decimal;
  realized: Decimal;
  income: Decimal;
}

export interface PortfolioState {
  portfolio: Portfolio;
  ledger: LedgerResult;
  holdings: HoldingValue[];
  marketValue: Decimal;
  totalValue: Decimal;
  totalUnits: Decimal;
  nav: Decimal;
  unitsByMembership: Map<number, Decimal>;
}

/** Everything derived about a portfolio right now. `extraTx` lets callers test a change before saving it. */
export async function computeState(portfolioId: number, db: Db = prisma, extraTx: LedgerTx[] = [], excludeTxId?: number): Promise<PortfolioState> {
  const [portfolio, txs, holdings, units] = await Promise.all([
    db.portfolio.findUniqueOrThrow({ where: { id: portfolioId } }),
    db.portfolioTransaction.findMany({ where: { portfolioId, status: 'ACTIVE' } }),
    db.holding.findMany({ where: { portfolioId }, orderBy: { name: 'asc' } }),
    db.unitEntry.groupBy({ by: ['membershipId'], where: { portfolioId }, _sum: { units: true } }),
  ]);
  const ledger = replay([...txs.filter((t) => t.id !== excludeTxId).map(toLedgerTx), ...extraTx]);

  const values: HoldingValue[] = holdings.map((holding) => {
    const p = ledger.positions.get(holding.id);
    const quantity = p?.quantity ?? ZERO;
    const cost = p?.cost ?? ZERO;
    const marketValue = quantity.mul(holding.currentPrice);
    return {
      holding,
      quantity,
      cost,
      avgCost: quantity.gt(0) ? cost.div(quantity) : ZERO,
      marketValue,
      unrealized: marketValue.sub(cost),
      realized: p?.realized ?? ZERO,
      income: p?.income ?? ZERO,
    };
  });
  const marketValue = values.reduce((s, v) => s.add(v.marketValue), ZERO);
  const totalValue = ledger.cash.add(marketValue);
  const unitsByMembership = new Map(units.map((u) => [u.membershipId, u._sum.units ?? ZERO]));
  const totalUnits = [...unitsByMembership.values()].reduce((s, u) => s.add(u), ZERO);
  return {
    portfolio,
    ledger,
    holdings: values,
    marketValue,
    totalValue,
    totalUnits,
    nav: navPerUnit(totalValue, totalUnits, portfolio.initialUnitPrice),
    unitsByMembership,
  };
}

export function groupTotals(s: PortfolioState) {
  const profit = s.totalValue.sub(s.ledger.invested);
  return {
    invested: num(s.ledger.invested),
    currentValue: num(s.totalValue),
    marketValue: num(s.marketValue),
    cash: num(s.ledger.cash),
    profit: num(profit),
    profitPercent: s.ledger.invested.gt(0) ? num(profit.div(s.ledger.invested).mul(100)) : 0,
    navPerUnit: num6(s.nav),
    totalUnits: num6(s.totalUnits),
    realized: num(s.ledger.realized),
    income: num(s.ledger.income),
    expenses: num(s.ledger.expenses),
    problems: s.ledger.problems,
  };
}

export function memberNumbers(s: PortfolioState, membershipId: number, contributed: Decimal, paidOut: Decimal = ZERO) {
  const units = s.unitsByMembership.get(membershipId) ?? ZERO;
  const value = units.mul(s.nav);
  const returns = value.add(paidOut).sub(contributed);
  return {
    contributed: num(contributed),
    units: num6(units),
    ownershipPercent: s.totalUnits.gt(0) ? num(units.div(s.totalUnits).mul(100)) : 0,
    currentValue: num(value),
    returns: num(returns),
    returnsPercent: contributed.gt(0) ? num(returns.div(contributed).mul(100)) : 0,
  };
}

/** Approved deposit totals and paid-out exits per membership. */
export async function capitalByMembership(portfolioId: number, db: Db = prisma) {
  const [deposits, exits] = await Promise.all([
    db.deposit.groupBy({ by: ['membershipId'], where: { portfolioId, status: 'APPROVED' }, _sum: { amount: true } }),
    db.exitRequest.groupBy({ by: ['membershipId'], where: { portfolioId, status: 'PAID' }, _sum: { payoutAmount: true } }),
  ]);
  return {
    contributed: new Map(deposits.map((d) => [d.membershipId, d._sum.amount ?? ZERO])),
    paidOut: new Map(exits.map((e) => [e.membershipId, e._sum.payoutAmount ?? ZERO])),
  };
}

/**
 * NEPSE auto-sync: copies the stored quote (kept fresh by `npm run sync` or the
 * live feed) into holdings priced from NEPSE, when the quote is newer.
 */
export async function applyNepsePrices(portfolioId: number, db: Db = prisma): Promise<number> {
  const holdings = await db.holding.findMany({ where: { portfolioId, priceSource: 'NEPSE', symbol: { not: null } } });
  if (holdings.length === 0) return 0;
  const instruments = await db.instrument.findMany({
    where: { symbol: { in: holdings.map((h) => h.symbol!) } },
    include: { quote: true },
  });
  const quoteBySymbol = new Map(instruments.filter((i) => i.quote).map((i) => [i.symbol, i.quote!]));
  let updated = 0;
  for (const h of holdings) {
    const quote = quoteBySymbol.get(h.symbol!);
    if (!quote || (h.priceUpdatedAt && h.priceUpdatedAt >= quote.fetchedAt && h.currentPrice.eq(quote.lastTradedPrice))) continue;
    await db.holding.update({ where: { id: h.id }, data: { currentPrice: quote.lastTradedPrice, priceUpdatedAt: quote.fetchedAt } });
    updated++;
  }
  return updated;
}

/** Upserts today's NAV snapshot (used by the growth chart and statements). */
export async function recordSnapshot(s: PortfolioState, db: Db = prisma): Promise<void> {
  const date = tradeDateToDb(kathmanduDate());
  const values = {
    navPerUnit: s.nav.toDecimalPlaces(6),
    totalValue: s.totalValue.toDecimalPlaces(4),
    cash: s.ledger.cash.toDecimalPlaces(4),
    invested: s.ledger.invested.toDecimalPlaces(4),
    totalUnits: s.totalUnits.toDecimalPlaces(6),
  };
  await db.navSnapshot.upsert({
    where: { portfolioId_date: { portfolioId: s.portfolio.id, date } },
    create: { portfolioId: s.portfolio.id, date, ...values },
    update: values,
  });
}

/** Fresh prices, current state and today's snapshot: what every dashboard read starts with. */
export async function currentState(portfolioId: number): Promise<PortfolioState> {
  await applyNepsePrices(portfolioId);
  const state = await computeState(portfolioId);
  await recordSnapshot(state);
  return state;
}

export const decimal = (v: number | string) => new Dec(v);
