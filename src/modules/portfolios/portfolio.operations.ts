import type { Request } from 'express';
import type { Deposit, Membership, PaymentMethod, Portfolio, PortfolioTransaction, Prisma, TransactionType } from '@prisma/client';
import { prisma } from '../../config/prisma.js';
import { AppError, ErrorCode } from '../../common/errors/app-error.js';
import { kathmanduDate, tradeDateToDb } from '../../common/utils/time.js';
import { audit } from '../audit/audit.js';
import { activeMemberIds, notify } from '../notifications/notify.js';
import { contributionCell, Dec, kathmanduMidnight, kathmanduMonth, lateCutoff, monthRange, NEEDS_HOLDING, unitsFor, ZERO, type ContributionCell, type Decimal, type LedgerTx } from './ledger.js';
import { computeState, lockPortfolio, num, num6, recordSnapshot } from './portfolio.service.js';

const fmt = (d: Decimal) => `Rs ${Number(d.toFixed(2)).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const memberLink = (portfolioId: number, page = '') => `/app/portfolios/${portfolioId}${page ? `/${page}` : ''}`;

const invalidState = (message: string) => new AppError(409, ErrorCode.INVALID_STATE, message);
const notFound = (what: string) => AppError.notFound(ErrorCode.NOT_FOUND, `${what} not found`);

async function hasOpenExit(db: Prisma.TransactionClient, membershipId: number) {
  return (await db.exitRequest.count({ where: { membershipId, status: { in: ['REQUESTED', 'APPROVED'] } } })) > 0;
}

// ---------------------------------------------------------------------------
// Deposits
// ---------------------------------------------------------------------------

/** Issues units for a deposit at the NAV just before it, and records the cash. Runs inside `db`'s transaction. */
async function issueUnits(req: Request, db: Prisma.TransactionClient, deposit: Deposit, portfolio: Portfolio) {
  await lockPortfolio(db, portfolio.id);
  const before = await computeState(portfolio.id, db);
  if (before.totalUnits.gt(0) && before.nav.lte(0)) {
    throw invalidState('NAV is zero or negative, so units cannot be priced. Reconcile cash and prices first.');
  }
  const units = unitsFor(deposit.amount, before.nav);
  const today = kathmanduDate();
  const tx = await db.portfolioTransaction.create({
    data: {
      portfolioId: portfolio.id,
      type: 'DEPOSIT',
      date: tradeDateToDb(today),
      amount: deposit.amount,
      note: `Deposit ${deposit.period} (receipt R-${portfolio.id}-${deposit.id})`,
      depositId: deposit.id,
      createdById: req.auth!.user.id,
    },
  });
  await db.unitEntry.create({
    data: { portfolioId: portfolio.id, membershipId: deposit.membershipId, kind: 'ISSUE', units, nav: before.nav.toDecimalPlaces(6), amount: deposit.amount, depositId: deposit.id },
  });
  const updated = await db.deposit.update({
    where: { id: deposit.id },
    data: {
      status: 'APPROVED',
      reviewedAt: new Date(),
      reviewedById: req.auth!.user.id,
      navAtApproval: before.nav.toDecimalPlaces(6),
      unitsIssued: units,
      receiptNo: `R-${portfolio.id}-${deposit.id}`,
      rejectionReason: null,
    },
  });
  await recordSnapshot(await computeState(portfolio.id, db), db);
  return { deposit: updated, units, nav: before.nav, txId: tx.id };
}

export async function approveDeposit(req: Request, portfolio: Portfolio, depositId: number) {
  return prisma.$transaction(async (db) => {
    const deposit = await db.deposit.findFirst({ where: { id: depositId, portfolioId: portfolio.id }, include: { membership: { include: { user: true } } } });
    if (!deposit) throw notFound('Deposit');
    if (deposit.status !== 'PENDING') throw invalidState(`This deposit is already ${deposit.status.toLowerCase()}`);
    if (deposit.membership.status !== 'ACTIVE') throw invalidState('The member is no longer active');
    if (await hasOpenExit(db, deposit.membershipId)) throw invalidState('The member has an open exit request');

    const result = await issueUnits(req, db, deposit, portfolio);
    await audit(req, {
      portfolioId: portfolio.id,
      action: 'deposit.approve',
      entityType: 'deposit',
      entityId: deposit.id,
      summary: `Approved ${fmt(deposit.amount)} from ${deposit.membership.user.name} for ${deposit.period}: ${result.units.toFixed(4)} units at NAV ${result.nav.toFixed(4)}`,
      data: { amount: deposit.amount.toString(), units: result.units.toString(), nav: result.nav.toString() },
    }, db);
    await notify([deposit.membership.userId], {
      type: 'DEPOSIT_APPROVED',
      portfolioId: portfolio.id,
      title: `Deposit approved: ${fmt(deposit.amount)}`,
      body: `${portfolio.name}, ${deposit.period}. ${result.units.toFixed(4)} units issued at NAV ${result.nav.toFixed(4)}.`,
      link: memberLink(portfolio.id, 'deposit'),
    }, db);
    return result.deposit;
  });
}

export async function rejectDeposit(req: Request, portfolio: Portfolio, depositId: number, reason: string) {
  return prisma.$transaction(async (db) => {
    const deposit = await db.deposit.findFirst({ where: { id: depositId, portfolioId: portfolio.id }, include: { membership: { include: { user: true } } } });
    if (!deposit) throw notFound('Deposit');
    if (deposit.status !== 'PENDING') throw invalidState(`This deposit is already ${deposit.status.toLowerCase()}`);
    const updated = await db.deposit.update({
      where: { id: deposit.id },
      data: { status: 'REJECTED', rejectionReason: reason, reviewedAt: new Date(), reviewedById: req.auth!.user.id },
    });
    await audit(req, {
      portfolioId: portfolio.id,
      action: 'deposit.reject',
      entityType: 'deposit',
      entityId: deposit.id,
      summary: `Rejected ${fmt(deposit.amount)} from ${deposit.membership.user.name} for ${deposit.period}: ${reason}`,
    }, db);
    await notify([deposit.membership.userId], {
      type: 'DEPOSIT_REJECTED',
      portfolioId: portfolio.id,
      title: `Deposit rejected: ${fmt(deposit.amount)}`,
      body: `${portfolio.name}, ${deposit.period}. Reason: ${reason}`,
      link: memberLink(portfolio.id, 'deposit'),
    }, db);
    return updated;
  });
}

export interface ManualDepositInput {
  membershipId: number;
  amount: number;
  period: string;
  method: PaymentMethod;
  reference?: string | undefined;
  note?: string | undefined;
  /** When the money actually arrived ('YYYY-MM-DD'); decides whether the late fee applies. Defaults to today. */
  receivedOn?: string | undefined;
}

/** A deposit the admin received directly (cash, or already verified): approved immediately. */
export async function createManualDeposit(req: Request, portfolio: Portfolio, input: ManualDepositInput) {
  return prisma.$transaction(async (db) => {
    const membership = await db.membership.findFirst({ where: { id: input.membershipId, portfolioId: portfolio.id, status: 'ACTIVE' }, include: { user: true } });
    if (!membership) throw notFound('Member');
    if (await hasOpenExit(db, membership.id)) throw invalidState('The member has an open exit request');
    const deposit = await db.deposit.create({
      data: {
        portfolioId: portfolio.id,
        membershipId: membership.id,
        amount: new Dec(input.amount),
        period: input.period,
        method: input.method,
        reference: input.reference ?? null,
        note: input.note ?? 'Recorded by admin',
        submittedById: req.auth!.user.id,
        // Midday Kathmandu time on the day received, so it lands on that calendar date.
        ...(input.receivedOn ? { submittedAt: new Date(kathmanduMidnight(input.receivedOn).getTime() + 12 * 3_600_000) } : {}),
      },
    });
    const result = await issueUnits(req, db, deposit, portfolio);
    await audit(req, {
      portfolioId: portfolio.id,
      action: 'deposit.manual',
      entityType: 'deposit',
      entityId: deposit.id,
      summary: `Recorded a ${input.method.toLowerCase()} deposit of ${fmt(deposit.amount)} for ${membership.user.name} (${input.period}): ${result.units.toFixed(4)} units`,
    }, db);
    await notify([membership.userId], {
      type: 'DEPOSIT_APPROVED',
      portfolioId: portfolio.id,
      title: `Deposit recorded: ${fmt(deposit.amount)}`,
      body: `${portfolio.name}, ${input.period}. ${result.units.toFixed(4)} units issued.`,
      link: memberLink(portfolio.id, 'deposit'),
    }, db);
    return result.deposit;
  });
}

// ---------------------------------------------------------------------------
// Contribution tracker
// ---------------------------------------------------------------------------

export interface TrackerRow {
  membershipId: number;
  userId: number;
  name: string;
  role: string;
  cells: ContributionCell[];
  lateCount: number;
  outstanding: number;
}

export async function contributionTracker(portfolio: Portfolio, opts: { membershipIds?: number[]; from?: string; to?: string } = {}) {
  const today = kathmanduDate();
  const currentMonth = today.slice(0, 7);
  const to = opts.to && opts.to < currentMonth ? opts.to : currentMonth;
  const from = opts.from && opts.from > portfolio.startMonth ? opts.from : portfolio.startMonth;
  const months = from <= to ? monthRange(from, to) : [];

  const memberships = await prisma.membership.findMany({
    where: { portfolioId: portfolio.id, status: 'ACTIVE', ...(opts.membershipIds ? { id: { in: opts.membershipIds } } : {}) },
    include: { user: { select: { id: true, name: true } } },
    orderBy: { joinedAt: 'asc' },
  });
  const deposits = await prisma.deposit.findMany({
    where: { portfolioId: portfolio.id, membershipId: { in: memberships.map((m) => m.id) }, period: { in: months }, status: { in: ['APPROVED', 'PENDING'] } },
    select: { membershipId: true, period: true, status: true, amount: true, submittedAt: true },
  });
  // Earliest month each member has paid (or tried to pay) for, at any time.
  const firstPaid = await prisma.deposit.groupBy({
    by: ['membershipId'],
    where: { portfolioId: portfolio.id, membershipId: { in: memberships.map((m) => m.id) }, status: { in: ['APPROVED', 'PENDING'] } },
    _min: { period: true },
  });
  const firstPaidBy = new Map(firstPaid.map((f) => [f.membershipId, f._min.period]));

  const rows: TrackerRow[] = memberships.map((m) => {
    // Owed from the month the member joined, or from the earliest month they paid for if that is earlier.
    const joined = kathmanduMonth(m.joinedAt);
    const paidFrom = firstPaidBy.get(m.id);
    const startsFrom = paidFrom && paidFrom < joined ? paidFrom : joined;
    const cells = months.map((period) => {
      const mine = deposits.filter((d) => d.membershipId === m.id && d.period === period);
      const owed = period >= startsFrom ? portfolio.contributionAmount : ZERO;
      const cutoff = lateCutoff(period, portfolio.dueDay, portfolio.graceDays);
      return contributionCell({
        period,
        today,
        amount: owed,
        dueDay: portfolio.dueDay,
        graceDays: portfolio.graceDays,
        lateFee: portfolio.lateFee,
        paid: mine.filter((d) => d.status === 'APPROVED').reduce((s, d) => s.add(d.amount), ZERO),
        submittedOnTime: mine.filter((d) => kathmanduDate(d.submittedAt) <= cutoff).reduce((s, d) => s.add(d.amount), ZERO),
        hasPending: mine.some((d) => d.status === 'PENDING'),
      });
    });
    return {
      membershipId: m.id,
      userId: m.user.id,
      name: m.user.name,
      role: m.role,
      cells,
      lateCount: cells.filter((c) => c.status === 'LATE').length,
      outstanding: cells.reduce((s, c) => s + c.outstanding, 0),
    };
  });
  return { months, rows, contributionAmount: num(portfolio.contributionAmount), dueDay: portfolio.dueDay, graceDays: portfolio.graceDays, lateFee: num(portfolio.lateFee) };
}

export async function sendReminders(req: Request, portfolio: Portfolio, membershipIds: number[]) {
  const { rows } = await contributionTracker(portfolio, { membershipIds });
  const due = rows.filter((r) => r.outstanding > 0);
  for (const r of due) {
    const open = r.cells.filter((c) => c.outstanding > 0);
    await notify([r.userId], {
      type: 'PAYMENT_DUE',
      portfolioId: portfolio.id,
      title: `Payment reminder: ${portfolio.name}`,
      body: `Rs ${r.outstanding.toLocaleString('en-IN')} outstanding for ${open.map((c) => c.period).join(', ')}.`,
      link: memberLink(portfolio.id, 'deposit'),
    });
  }
  await audit(req, {
    portfolioId: portfolio.id,
    action: 'tracker.remind',
    summary: `Sent payment reminders to ${due.length} member(s): ${due.map((r) => r.name).join(', ') || 'none due'}`,
  });
  return { reminded: due.length };
}

// ---------------------------------------------------------------------------
// Exits
// ---------------------------------------------------------------------------

export async function requestExit(req: Request, portfolio: Portfolio, membership: Membership, reason?: string) {
  if (await hasOpenExit(prisma, membership.id)) throw invalidState('You already have an open exit request');
  const exit = await prisma.exitRequest.create({ data: { portfolioId: portfolio.id, membershipId: membership.id, reason: reason ?? null } });
  await audit(req, { portfolioId: portfolio.id, action: 'exit.request', entityType: 'exit', entityId: exit.id, summary: `${req.auth!.user.name} requested to exit` });
  const admins = await prisma.membership.findMany({ where: { portfolioId: portfolio.id, status: 'ACTIVE', role: 'ADMIN' }, select: { userId: true } });
  await notify(admins.map((a) => a.userId), {
    type: 'EXIT_UPDATE',
    portfolioId: portfolio.id,
    title: `Exit request from ${req.auth!.user.name}`,
    body: reason ?? undefined,
  });
  return exit;
}

async function loadExit(db: Prisma.TransactionClient, portfolio: Portfolio, exitId: number) {
  const exit = await db.exitRequest.findFirst({ where: { id: exitId, portfolioId: portfolio.id }, include: { membership: { include: { user: true } } } });
  if (!exit) throw notFound('Exit request');
  return exit;
}

export async function approveExit(req: Request, portfolio: Portfolio, exitId: number) {
  return prisma.$transaction(async (db) => {
    await lockPortfolio(db, portfolio.id);
    const exit = await loadExit(db, portfolio, exitId);
    if (exit.status !== 'REQUESTED') throw invalidState(`This request is already ${exit.status.toLowerCase()}`);
    const state = await computeState(portfolio.id, db);
    const units = state.unitsByMembership.get(exit.membershipId) ?? ZERO;
    const payout = units.mul(state.nav).toDecimalPlaces(2, Dec.ROUND_DOWN);
    const updated = await db.exitRequest.update({
      where: { id: exit.id },
      data: { status: 'APPROVED', approvedAt: new Date(), decidedById: req.auth!.user.id, navAtApproval: state.nav.toDecimalPlaces(6), units, payoutAmount: payout },
    });
    await audit(req, {
      portfolioId: portfolio.id,
      action: 'exit.approve',
      entityType: 'exit',
      entityId: exit.id,
      summary: `Approved exit for ${exit.membership.user.name}: ${units.toFixed(4)} units at NAV ${state.nav.toFixed(4)} = ${fmt(payout)}`,
    }, db);
    await notify([exit.membership.userId], {
      type: 'EXIT_UPDATE',
      portfolioId: portfolio.id,
      title: 'Exit request approved',
      body: `Payout of ${fmt(payout)} at NAV ${state.nav.toFixed(4)} will be paid soon.`,
      link: memberLink(portfolio.id, 'exit'),
    }, db);
    return updated;
  });
}

export async function rejectExit(req: Request, portfolio: Portfolio, exitId: number, reason: string) {
  return prisma.$transaction(async (db) => {
    const exit = await loadExit(db, portfolio, exitId);
    if (exit.status !== 'REQUESTED' && exit.status !== 'APPROVED') throw invalidState(`This request is already ${exit.status.toLowerCase()}`);
    const updated = await db.exitRequest.update({ where: { id: exit.id }, data: { status: 'REJECTED', rejectionReason: reason, decidedById: req.auth!.user.id } });
    await audit(req, { portfolioId: portfolio.id, action: 'exit.reject', entityType: 'exit', entityId: exit.id, summary: `Rejected exit for ${exit.membership.user.name}: ${reason}` }, db);
    await notify([exit.membership.userId], { type: 'EXIT_UPDATE', portfolioId: portfolio.id, title: 'Exit request rejected', body: reason, link: memberLink(portfolio.id, 'exit') }, db);
    return updated;
  });
}

/** Pays out an approved exit: cash leaves, the member's units are redeemed and the membership closes. */
export async function markExitPaid(req: Request, portfolio: Portfolio, exitId: number, reference?: string) {
  return prisma.$transaction(async (db) => {
    await lockPortfolio(db, portfolio.id);
    const exit = await loadExit(db, portfolio, exitId);
    if (exit.status !== 'APPROVED' || !exit.payoutAmount || !exit.units || !exit.navAtApproval) throw invalidState('Only approved exits can be marked paid');
    const today = tradeDateToDb(kathmanduDate());
    await db.portfolioTransaction.create({
      data: {
        portfolioId: portfolio.id,
        type: 'EXIT_PAYOUT',
        date: today,
        amount: exit.payoutAmount,
        note: `Exit payout to ${exit.membership.user.name}${reference ? ` (ref ${reference})` : ''}`,
        exitId: exit.id,
        createdById: req.auth!.user.id,
      },
    });
    await db.unitEntry.create({
      data: { portfolioId: portfolio.id, membershipId: exit.membershipId, kind: 'REDEEM', units: exit.units.neg(), nav: exit.navAtApproval, amount: exit.payoutAmount.neg(), exitId: exit.id },
    });
    await db.membership.update({ where: { id: exit.membershipId }, data: { status: 'EXITED', leftAt: new Date() } });
    const updated = await db.exitRequest.update({ where: { id: exit.id }, data: { status: 'PAID', paidAt: new Date(), paidReference: reference ?? null } });
    await recordSnapshot(await computeState(portfolio.id, db), db);
    await audit(req, {
      portfolioId: portfolio.id,
      action: 'exit.paid',
      entityType: 'exit',
      entityId: exit.id,
      summary: `Paid ${fmt(exit.payoutAmount)} to ${exit.membership.user.name} and redeemed ${exit.units.toFixed(4)} units`,
    }, db);
    await notify([exit.membership.userId], {
      type: 'EXIT_UPDATE',
      portfolioId: portfolio.id,
      title: `Exit payout sent: ${fmt(exit.payoutAmount)}`,
      body: reference ? `Reference: ${reference}` : undefined,
      link: memberLink(portfolio.id, 'exit'),
    }, db);
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

export const MANUAL_TYPES = ['BUY', 'SELL', 'DIVIDEND', 'BONUS_SHARE', 'RIGHT_SHARE', 'FEE', 'WITHDRAWAL', 'ADJUSTMENT'] as const;
export type ManualType = (typeof MANUAL_TYPES)[number];
const TRADE_TYPES: ReadonlySet<TransactionType> = new Set(['BUY', 'SELL', 'DIVIDEND', 'BONUS_SHARE', 'RIGHT_SHARE', 'FEE', 'WITHDRAWAL']);

export interface TransactionInput {
  type: ManualType;
  date: string;
  holdingId?: number | null | undefined;
  quantity?: number | null | undefined;
  price?: number | null | undefined;
  amount?: number | null | undefined;
  fees?: number | undefined;
  note: string;
}

const dec = (v: number | null | undefined) => (v === null || v === undefined ? null : new Dec(v));

function validateShape(t: TransactionInput): void {
  const need = (cond: boolean, msg: string) => {
    if (!cond) throw new AppError(400, ErrorCode.VALIDATION_ERROR, msg);
  };
  if (NEEDS_HOLDING.has(t.type)) need(!!t.holdingId, 'Choose the asset');
  if (['BUY', 'SELL', 'RIGHT_SHARE', 'BONUS_SHARE'].includes(t.type)) need((t.quantity ?? 0) > 0, 'Quantity must be more than 0');
  if (['BUY', 'SELL', 'RIGHT_SHARE'].includes(t.type)) need((t.price ?? 0) > 0, 'Price must be more than 0');
  if (['DIVIDEND', 'FEE', 'WITHDRAWAL'].includes(t.type)) need((t.amount ?? 0) > 0, 'Amount must be more than 0');
  if (t.type === 'ADJUSTMENT') need(!!t.amount, 'Adjustment amount cannot be 0');
  need((t.fees ?? 0) >= 0, 'Fees cannot be negative');
  need(t.date <= kathmanduDate(), 'Date cannot be in the future');
}

function dataFor(t: TransactionInput) {
  const usesQty = ['BUY', 'SELL', 'RIGHT_SHARE', 'BONUS_SHARE'].includes(t.type);
  const usesPrice = ['BUY', 'SELL', 'RIGHT_SHARE'].includes(t.type);
  const usesAmount = ['DIVIDEND', 'FEE', 'WITHDRAWAL', 'ADJUSTMENT'].includes(t.type);
  return {
    type: t.type,
    date: tradeDateToDb(t.date),
    holdingId: t.holdingId ?? null,
    quantity: usesQty ? dec(t.quantity) : null,
    price: usesPrice ? dec(t.price) : null,
    amount: usesAmount ? dec(t.amount) : null,
    fees: new Dec(t.fees ?? 0),
    note: t.note,
  };
}

const candidate = (id: number, input: TransactionInput, d: ReturnType<typeof dataFor>): LedgerTx => ({
  id,
  type: d.type,
  date: input.date,
  holdingId: d.holdingId,
  quantity: d.quantity,
  price: d.price,
  amount: d.amount,
  fees: d.fees,
});

/** Replays the ledger with the change applied and refuses it if a sale would exceed holdings. */
async function assertLedgerOk(db: Prisma.TransactionClient, portfolioId: number, candidate: LedgerTx, excludeId?: number) {
  const state = await computeState(portfolioId, db, [candidate], excludeId);
  const problem = state.ledger.problems[0];
  if (problem) throw invalidState(problem.message);
}

async function checkHolding(db: Prisma.TransactionClient, portfolioId: number, holdingId: number | null | undefined) {
  if (!holdingId) return;
  if (!(await db.holding.findFirst({ where: { id: holdingId, portfolioId } }))) throw notFound('Asset');
}

const describeTx = (t: { type: TransactionType; quantity: Decimal | null; price: Decimal | null; amount: Decimal | null }, holdingName?: string) => {
  const what = holdingName ? ` ${holdingName}` : '';
  switch (t.type) {
    case 'BUY':
    case 'SELL':
    case 'RIGHT_SHARE':
      return `${t.type.replace('_', ' ').toLowerCase()} ${t.quantity?.toString()}${what} @ ${t.price?.toString()}`;
    case 'BONUS_SHARE':
      return `bonus ${t.quantity?.toString()}${what}`;
    default:
      return `${t.type.toLowerCase()}${what} ${t.amount ? fmt(t.amount) : ''}`.trim();
  }
};

export async function createTransaction(req: Request, portfolio: Portfolio, input: TransactionInput) {
  validateShape(input);
  return prisma.$transaction(async (db) => {
    await lockPortfolio(db, portfolio.id);
    await checkHolding(db, portfolio.id, input.holdingId);
    const data = dataFor(input);
    await assertLedgerOk(db, portfolio.id, candidate(Number.MAX_SAFE_INTEGER, input, data));
    const tx = await db.portfolioTransaction.create({ data: { ...data, portfolioId: portfolio.id, createdById: req.auth!.user.id }, include: { holding: true } });
    await recordSnapshot(await computeState(portfolio.id, db), db);
    const description = describeTx(tx, tx.holding?.name);
    await audit(req, { portfolioId: portfolio.id, action: 'transaction.create', entityType: 'transaction', entityId: tx.id, summary: `Recorded ${description}. Note: ${input.note}` }, db);
    if (TRADE_TYPES.has(tx.type)) {
      await notify(await activeMemberIds(portfolio.id, db), {
        type: 'NEW_TRADE',
        portfolioId: portfolio.id,
        title: `${portfolio.name}: ${description}`,
        body: input.note,
        link: memberLink(portfolio.id, 'activity'),
      }, db);
    }
    return tx;
  });
}

async function editableTx(db: Prisma.TransactionClient, portfolio: Portfolio, txId: number): Promise<PortfolioTransaction> {
  const tx = await db.portfolioTransaction.findFirst({ where: { id: txId, portfolioId: portfolio.id } });
  if (!tx) throw notFound('Transaction');
  if (tx.depositId || tx.exitId) throw invalidState('Deposits and exit payouts are changed from the Deposits and Exits pages');
  if (tx.status === 'REVERSED') throw invalidState('This transaction has been reversed');
  return tx;
}

export async function updateTransaction(req: Request, portfolio: Portfolio, txId: number, input: TransactionInput) {
  validateShape(input);
  return prisma.$transaction(async (db) => {
    await lockPortfolio(db, portfolio.id);
    const before = await editableTx(db, portfolio, txId);
    await checkHolding(db, portfolio.id, input.holdingId);
    const data = dataFor(input);
    await assertLedgerOk(db, portfolio.id, candidate(before.id, input, data), before.id);
    const tx = await db.portfolioTransaction.update({ where: { id: before.id }, data, include: { holding: true } });
    await recordSnapshot(await computeState(portfolio.id, db), db);
    await audit(req, {
      portfolioId: portfolio.id,
      action: 'transaction.edit',
      entityType: 'transaction',
      entityId: tx.id,
      summary: `Edited transaction #${tx.id}: now ${describeTx(tx, tx.holding?.name)}. Note: ${input.note}`,
      data: { before: JSON.parse(JSON.stringify(before)), after: JSON.parse(JSON.stringify(tx)) },
    }, db);
    return tx;
  });
}

export async function reverseTransaction(req: Request, portfolio: Portfolio, txId: number, note: string) {
  return prisma.$transaction(async (db) => {
    await lockPortfolio(db, portfolio.id);
    const tx = await editableTx(db, portfolio, txId);
    // Removing a buy can make a later sale invalid.
    const state = await computeState(portfolio.id, db, [], tx.id);
    if (state.ledger.problems[0]) throw invalidState(`Reversing this would break a later transaction: ${state.ledger.problems[0].message}`);
    const updated = await db.portfolioTransaction.update({ where: { id: tx.id }, data: { status: 'REVERSED', reversedAt: new Date(), reverseNote: note } });
    await recordSnapshot(state, db);
    await audit(req, { portfolioId: portfolio.id, action: 'transaction.reverse', entityType: 'transaction', entityId: tx.id, summary: `Reversed transaction #${tx.id} (${describeTx(tx)}). Note: ${note}` }, db);
    return updated;
  });
}

export const serializeTx = (t: PortfolioTransaction & { holding?: { id: number; name: string; symbol: string | null } | null }) => ({
  id: t.id,
  type: t.type,
  status: t.status,
  date: t.date.toISOString().slice(0, 10),
  holdingId: t.holdingId,
  holdingName: t.holding?.name ?? null,
  holdingSymbol: t.holding?.symbol ?? null,
  quantity: t.quantity ? num6(t.quantity) : null,
  price: t.price ? num(t.price) : null,
  amount: t.amount ? num(t.amount) : null,
  fees: num(t.fees),
  note: t.note,
  linked: t.depositId ? 'deposit' : t.exitId ? 'exit' : null,
  reversedAt: t.reversedAt?.toISOString() ?? null,
  reverseNote: t.reverseNote,
  createdAt: t.createdAt.toISOString(),
});
