import { describe, expect, it } from 'vitest';
import {
  contributionCell,
  Dec,
  monthRange,
  navPerUnit,
  nextMonthStart,
  replay,
  unitsFor,
  type LedgerTx,
} from '../../src/modules/portfolios/ledger.js';

let nextId = 1;
const tx = (t: Partial<LedgerTx> & Pick<LedgerTx, 'type'>): LedgerTx => ({
  id: nextId++,
  date: '2026-01-10',
  holdingId: null,
  quantity: null,
  price: null,
  amount: null,
  fees: new Dec(0),
  ...t,
});
const d = (v: number) => new Dec(v);

describe('replay', () => {
  it('derives cash, cost basis and realized gain from buys and sells', () => {
    const r = replay([
      tx({ type: 'DEPOSIT', amount: d(10_000) }),
      tx({ type: 'BUY', holdingId: 1, quantity: d(10), price: d(500), fees: d(50), date: '2026-01-11' }),
      tx({ type: 'SELL', holdingId: 1, quantity: d(4), price: d(600), fees: d(20), date: '2026-01-12' }),
    ]);
    const p = r.positions.get(1)!;
    expect(p.quantity.toNumber()).toBe(6);
    // Cost 5050 for 10 → 505 each; 4 sold → 2020 of cost removed.
    expect(p.cost.toNumber()).toBe(3030);
    expect(r.realized.toNumber()).toBe(2400 - 20 - 2020);
    expect(r.cash.toNumber()).toBe(10_000 - 5050 + 2380);
    expect(r.invested.toNumber()).toBe(10_000);
    expect(r.problems).toEqual([]);
  });

  it('replays in date order, not insertion order', () => {
    const sell = tx({ type: 'SELL', holdingId: 1, quantity: d(5), price: d(10), date: '2026-02-01' });
    const buy = tx({ type: 'BUY', holdingId: 1, quantity: d(5), price: d(8), date: '2026-01-01' });
    expect(replay([sell, buy]).problems).toEqual([]);
  });

  it('flags selling more than is held', () => {
    const r = replay([tx({ type: 'SELL', holdingId: 1, quantity: d(1), price: d(10) })]);
    expect(r.problems).toHaveLength(1);
  });

  it('bonus shares add quantity without cost; dividends, fees and exits move cash', () => {
    const r = replay([
      tx({ type: 'DEPOSIT', amount: d(1000) }),
      tx({ type: 'BUY', holdingId: 2, quantity: d(10), price: d(100) }),
      tx({ type: 'BONUS_SHARE', holdingId: 2, quantity: d(2) }),
      tx({ type: 'DIVIDEND', holdingId: 2, amount: d(50), fees: d(5) }),
      tx({ type: 'FEE', amount: d(15) }),
      tx({ type: 'EXIT_PAYOUT', amount: d(30) }),
      tx({ type: 'ADJUSTMENT', amount: d(-1) }),
    ]);
    expect(r.positions.get(2)!.quantity.toNumber()).toBe(12);
    expect(r.positions.get(2)!.cost.toNumber()).toBe(1000);
    expect(r.cash.toNumber()).toBe(0 + 45 - 15 - 30 - 1);
    expect(r.invested.toNumber()).toBe(970);
    expect(r.income.toNumber()).toBe(45);
  });
});

describe('units', () => {
  it('uses the initial price before any units exist, then value / units', () => {
    expect(navPerUnit(d(0), d(0), d(10)).toNumber()).toBe(10);
    expect(navPerUnit(d(1500), d(100), d(10)).toNumber()).toBe(15);
  });

  it('a new deposit buys units at the current NAV without changing it', () => {
    const nav = navPerUnit(d(1500), d(100), d(10));
    const issued = unitsFor(d(300), nav);
    expect(issued.toNumber()).toBe(20);
    expect(navPerUnit(d(1800), d(100).add(issued), d(10)).toNumber()).toBe(15);
  });

  it('rounds units down so they are never over-issued', () => {
    expect(unitsFor(d(100), d(3)).toString()).toBe('33.333333');
  });

  it('refuses to price units at a non-positive NAV', () => {
    expect(() => unitsFor(d(100), d(0))).toThrow(RangeError);
  });
});

describe('contribution calendar', () => {
  const base = { amount: d(1000), dueDay: 10, graceDays: 2, lateFee: d(100), paid: d(0), submittedOnTime: d(0), hasPending: false };

  it('is due until the grace period ends, then late with the fee', () => {
    expect(contributionCell({ ...base, period: '2026-03', today: '2026-03-12' }).status).toBe('DUE');
    const late = contributionCell({ ...base, period: '2026-03', today: '2026-03-13' });
    expect(late.status).toBe('LATE');
    expect(late.outstanding).toBe(1100);
  });

  it('is paid once approved deposits cover the amount, pending while one awaits review', () => {
    expect(contributionCell({ ...base, period: '2026-03', today: '2026-04-01', paid: d(1000), submittedOnTime: d(1000) }).status).toBe('PAID');
    expect(contributionCell({ ...base, period: '2026-03', today: '2026-04-01', hasPending: true }).status).toBe('PENDING');
  });

  it('charges the late fee only when the amount was not submitted by the cutoff', () => {
    // Paid on time: never late, even after the cutoff.
    expect(contributionCell({ ...base, period: '2026-03', today: '2026-05-01', paid: d(1000), submittedOnTime: d(1000) }).status).toBe('PAID');
    // Paid the base amount after the cutoff: the fee is still owed.
    const short = contributionCell({ ...base, period: '2026-03', today: '2026-05-01', paid: d(1000) });
    expect(short.status).toBe('LATE');
    expect(short.outstanding).toBe(100);
    expect(contributionCell({ ...base, period: '2026-03', today: '2026-05-01', paid: d(1100) }).status).toBe('PAID');
  });

  it('counts partial payments toward the amount owed', () => {
    expect(contributionCell({ ...base, period: '2026-03', today: '2026-03-01', paid: d(400) }).outstanding).toBe(600);
  });

  it('builds month ranges across year boundaries', () => {
    expect(monthRange('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(nextMonthStart('2025-12')).toBe('2026-01-01');
  });
});
