/**
 * Pure portfolio accounting. Nothing here touches the database.
 *
 * - Cash and holdings are never stored as running balances: they are derived by
 *   replaying the portfolio's ACTIVE transactions in date order. Editing or
 *   reversing a transaction therefore can't leave balances out of step.
 * - Units work like a mutual fund. NAV per unit = (cash + market value) / units.
 *   An approved deposit buys units at the NAV just before the deposit, so it
 *   neither dilutes nor benefits existing members.
 */
import { Prisma, type TransactionType } from '@prisma/client';

export type Decimal = Prisma.Decimal;
export const Dec = Prisma.Decimal;
export const ZERO = new Dec(0);

export interface LedgerTx {
  id: number;
  type: TransactionType;
  date: string;
  holdingId: number | null;
  quantity: Decimal | null;
  price: Decimal | null;
  amount: Decimal | null;
  fees: Decimal;
}

export interface Position {
  quantity: Decimal;
  /** Remaining cost basis, including buy fees. */
  cost: Decimal;
  realized: Decimal;
  income: Decimal;
}

export interface LedgerResult {
  cash: Decimal;
  /** Deposits minus exit payouts: the members' net capital. */
  invested: Decimal;
  positions: Map<number, Position>;
  realized: Decimal;
  income: Decimal;
  expenses: Decimal;
  /** Transactions that don't make sense in sequence, e.g. selling more than is held. */
  problems: { txId: number; message: string }[];
}

const q = (v: Decimal | null) => v ?? ZERO;

export const compareTx = (a: Pick<LedgerTx, 'date' | 'id'>, b: Pick<LedgerTx, 'date' | 'id'>) =>
  a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id;

/** Whether a transaction type moves a holding's quantity, and so needs a holding. */
export const NEEDS_HOLDING: ReadonlySet<TransactionType> = new Set(['BUY', 'SELL', 'BONUS_SHARE', 'RIGHT_SHARE']);

export function replay(transactions: readonly LedgerTx[]): LedgerResult {
  const result: LedgerResult = {
    cash: ZERO,
    invested: ZERO,
    positions: new Map(),
    realized: ZERO,
    income: ZERO,
    expenses: ZERO,
    problems: [],
  };
  const position = (id: number) => {
    let p = result.positions.get(id);
    if (!p) result.positions.set(id, (p = { quantity: ZERO, cost: ZERO, realized: ZERO, income: ZERO }));
    return p;
  };

  for (const tx of [...transactions].sort(compareTx)) {
    const qty = q(tx.quantity);
    const gross = qty.mul(q(tx.price));
    switch (tx.type) {
      case 'BUY':
      case 'RIGHT_SHARE': {
        const p = position(tx.holdingId!);
        p.quantity = p.quantity.add(qty);
        p.cost = p.cost.add(gross).add(tx.fees);
        result.cash = result.cash.sub(gross).sub(tx.fees);
        break;
      }
      case 'SELL': {
        const p = position(tx.holdingId!);
        if (qty.gt(p.quantity)) {
          result.problems.push({ txId: tx.id, message: `Sells ${qty.toString()} but only ${p.quantity.toString()} are held at that date` });
        }
        const avg = p.quantity.gt(0) ? p.cost.div(p.quantity) : ZERO;
        const soldCost = avg.mul(Prisma.Decimal.min(qty, p.quantity));
        const gain = gross.sub(tx.fees).sub(soldCost);
        p.quantity = p.quantity.sub(qty);
        p.cost = p.quantity.gt(0) ? p.cost.sub(soldCost) : ZERO;
        p.realized = p.realized.add(gain);
        result.realized = result.realized.add(gain);
        result.cash = result.cash.add(gross).sub(tx.fees);
        break;
      }
      case 'BONUS_SHARE': {
        const p = position(tx.holdingId!);
        p.quantity = p.quantity.add(qty);
        break;
      }
      case 'DIVIDEND': {
        const net = q(tx.amount).sub(tx.fees);
        if (tx.holdingId) position(tx.holdingId).income = position(tx.holdingId).income.add(net);
        result.income = result.income.add(net);
        result.cash = result.cash.add(net);
        break;
      }
      case 'FEE':
      case 'WITHDRAWAL': {
        const out = q(tx.amount).add(tx.fees);
        result.expenses = result.expenses.add(out);
        result.cash = result.cash.sub(out);
        break;
      }
      case 'DEPOSIT':
        result.cash = result.cash.add(q(tx.amount));
        result.invested = result.invested.add(q(tx.amount));
        break;
      case 'EXIT_PAYOUT':
        result.cash = result.cash.sub(q(tx.amount));
        result.invested = result.invested.sub(q(tx.amount));
        break;
      case 'ADJUSTMENT':
        result.cash = result.cash.add(q(tx.amount));
        break;
    }
  }
  return result;
}

/** NAV per unit. Before any units exist, the portfolio's initial unit price. */
export function navPerUnit(totalValue: Decimal, totalUnits: Decimal, initialUnitPrice: Decimal): Decimal {
  return totalUnits.gt(0) ? totalValue.div(totalUnits) : initialUnitPrice;
}

/** Units bought by `amount` at `nav`, rounded down to 6 decimals so units are never over-issued. */
export function unitsFor(amount: Decimal, nav: Decimal): Decimal {
  if (nav.lte(0)) throw new RangeError('NAV must be positive to issue units');
  return amount.div(nav).toDecimalPlaces(6, Prisma.Decimal.ROUND_DOWN);
}

// ---------------------------------------------------------------------------
// Contribution calendar
// ---------------------------------------------------------------------------

export type ContributionStatus = 'PAID' | 'PENDING' | 'DUE' | 'LATE' | 'NOT_REQUIRED';

/** Inclusive list of 'YYYY-MM' months from `from` to `to`. */
export function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number) as [number, number];
  const [ty, tm] = to.split('-').map(Number) as [number, number];
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    if (++m > 12) {
      m = 1;
      y++;
    }
    if (out.length > 1200) break;
  }
  return out;
}

export const dueDate = (period: string, dueDay: number) => `${period}-${String(dueDay).padStart(2, '0')}`;

export function addDaysTo(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface ContributionInput {
  period: string;
  /** Kathmandu date, 'YYYY-MM-DD'. */
  today: string;
  amount: Decimal;
  dueDay: number;
  graceDays: number;
  lateFee: Decimal;
  /** Approved deposits for the month. */
  paid: Decimal;
  /** Approved or pending deposits submitted by the late cutoff (due day + grace days). */
  submittedOnTime: Decimal;
  hasPending: boolean;
}

export interface ContributionCell {
  period: string;
  status: ContributionStatus;
  dueDate: string;
  paid: number;
  /** Still owed, including the late fee once late. */
  outstanding: number;
  lateFee: number;
}

/**
 * One member-month. Once the cutoff (due day + grace days) has passed, the late
 * fee is owed on top of the amount unless the full amount had been submitted by
 * the cutoff; the month is PAID when approved deposits cover everything owed.
 */
export function contributionCell(c: ContributionInput): ContributionCell {
  const due = dueDate(c.period, c.dueDay);
  const cutoff = addDaysTo(due, c.graceDays);
  const pastCutoff = c.today > cutoff;
  const base = { period: c.period, dueDate: due, paid: c.paid.toNumber() };
  if (c.amount.lte(0)) return { ...base, status: 'NOT_REQUIRED', outstanding: 0, lateFee: 0 };
  const fee = pastCutoff && c.submittedOnTime.lt(c.amount) ? c.lateFee : ZERO;
  const owed = c.amount.add(fee);
  if (c.paid.gte(owed)) return { ...base, status: 'PAID', outstanding: 0, lateFee: fee.toNumber() };
  const outstanding = owed.sub(c.paid).toNumber();
  if (c.hasPending) return { ...base, status: 'PENDING', outstanding, lateFee: fee.toNumber() };
  return { ...base, status: pastCutoff ? 'LATE' : 'DUE', outstanding, lateFee: fee.toNumber() };
}

/** Late cutoff for a month: the last day a payment counts as on time. */
export const lateCutoff = (period: string, dueDay: number, graceDays: number) => addDaysTo(dueDate(period, dueDay), graceDays);

/** Kathmandu calendar month of an instant. */
export function kathmanduMonth(instant: Date): string {
  return new Date(instant.getTime() + (5 * 60 + 45) * 60_000).toISOString().slice(0, 7);
}

/** UTC instant of Kathmandu midnight at the start of a 'YYYY-MM-DD' date. */
export function kathmanduMidnight(date: string): Date {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() - (5 * 60 + 45) * 60_000);
}

/** First day of the month after `period`. */
export function nextMonthStart(period: string): string {
  const [y, m] = period.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}
