import { Router, type Request } from 'express';
import type { Deposit, ExitRequest, Portfolio } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../config/prisma.js';
import { AppError, ErrorCode } from '../../common/errors/app-error.js';
import { discardUpload, screenshotUpload, sendStored, verifyUpload } from '../../common/uploads.js';
import { kathmanduDate } from '../../common/utils/time.js';
import { audit } from '../audit/audit.js';
import { addDaysTo, Dec, dueDate, kathmanduMidnight, nextMonthStart, ZERO } from './ledger.js';
import { idOf, ownMembership, pctx, portfolioAccess } from './portfolio.access.js';
import { contributionTracker, requestExit, serializeTx } from './portfolio.operations.js';
import { capitalByMembership, currentState, groupTotals, memberNumbers, num, num6, type HoldingValue } from './portfolio.service.js';
import { buildStatement, sendReceiptPdf, sendStatementPdf, statementMonths } from './statements.js';

export const memberRouter = Router({ mergeParams: true });
memberRouter.use(portfolioAccess('MEMBER'));

const nextMonth = (period: string) => nextMonthStart(period).slice(0, 7);
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be YYYY-MM');
const isManager = (req: Request) => pctx(req).role !== 'MEMBER';

export const portfolioInfo = (p: Portfolio) => ({
  id: p.id,
  name: p.name,
  type: p.type,
  status: p.status,
  startMonth: p.startMonth,
  contributionAmount: num(p.contributionAmount),
  dueDay: p.dueDay,
  graceDays: p.graceDays,
  lateFee: num(p.lateFee),
  initialUnitPrice: num6(p.initialUnitPrice),
  membersSeeTracker: p.membersSeeTracker,
  membersSeeShares: p.membersSeeShares,
  createdAt: p.createdAt.toISOString(),
});

export const serializeHolding = (v: HoldingValue) => ({
  id: v.holding.id,
  assetType: v.holding.assetType,
  symbol: v.holding.symbol,
  name: v.holding.name,
  sector: v.holding.sector,
  quantity: num6(v.quantity),
  avgCost: num(v.avgCost),
  costBasis: num(v.cost),
  currentPrice: num(v.holding.currentPrice),
  priceSource: v.holding.priceSource,
  priceUpdatedAt: v.holding.priceUpdatedAt?.toISOString() ?? null,
  marketValue: num(v.marketValue),
  unrealized: num(v.unrealized),
  unrealizedPercent: v.cost.gt(0) ? num(v.unrealized.div(v.cost).mul(100)) : 0,
  realized: num(v.realized),
  income: num(v.income),
  archived: v.holding.archived,
});

export const serializeDeposit = (d: Deposit, memberName?: string) => ({
  id: d.id,
  membershipId: d.membershipId,
  memberName: memberName ?? null,
  amount: num(d.amount),
  period: d.period,
  method: d.method,
  status: d.status,
  reference: d.reference,
  note: d.note,
  hasScreenshot: !!d.screenshotPath,
  rejectionReason: d.rejectionReason,
  receiptNo: d.receiptNo,
  navAtApproval: d.navAtApproval ? num6(d.navAtApproval) : null,
  unitsIssued: d.unitsIssued ? num6(d.unitsIssued) : null,
  submittedAt: d.submittedAt.toISOString(),
  reviewedAt: d.reviewedAt?.toISOString() ?? null,
});

export const serializeExit = (e: ExitRequest, memberName?: string) => ({
  id: e.id,
  membershipId: e.membershipId,
  memberName: memberName ?? null,
  status: e.status,
  reason: e.reason,
  navAtApproval: e.navAtApproval ? num6(e.navAtApproval) : null,
  units: e.units ? num6(e.units) : null,
  payoutAmount: e.payoutAmount ? num(e.payoutAmount) : null,
  paidReference: e.paidReference,
  rejectionReason: e.rejectionReason,
  requestedAt: e.requestedAt.toISOString(),
  approvedAt: e.approvedAt?.toISOString() ?? null,
  paidAt: e.paidAt?.toISOString() ?? null,
});

export function paymentDetails(p: Portfolio) {
  const v = (p.paymentDetails ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof v[k] === 'string' && v[k] ? (v[k] as string) : null);
  return {
    bankName: s('bankName'),
    accountName: s('accountName'),
    accountNumber: s('accountNumber'),
    branch: s('branch'),
    esewaId: s('esewaId'),
    esewaName: s('esewaName'),
    instructions: s('instructions'),
  };
}

// --- dashboard ---------------------------------------------------------------

memberRouter.get('/', async (req, res) => {
  const ctx = pctx(req);
  const state = await currentState(ctx.portfolio.id);
  let mine = null;
  if (ctx.membership) {
    const capital = await capitalByMembership(ctx.portfolio.id);
    mine = memberNumbers(state, ctx.membership.id, capital.contributed.get(ctx.membership.id) ?? ZERO, capital.paidOut.get(ctx.membership.id));
  }
  res.json({
    data: {
      portfolio: portfolioInfo(ctx.portfolio),
      role: ctx.role,
      readOnly: ctx.readOnly,
      membershipId: ctx.membership?.id ?? null,
      totals: groupTotals(state),
      mine,
      holdingsCount: state.holdings.filter((h) => h.quantity.gt(0)).length,
    },
  });
});

/** Growth over time: daily NAV snapshots, plus the caller's own value on each date. */
memberRouter.get('/growth', async (req, res) => {
  const ctx = pctx(req);
  const snapshots = await prisma.navSnapshot.findMany({ where: { portfolioId: ctx.portfolio.id }, orderBy: { date: 'asc' } });
  const entries = ctx.membership ? await prisma.unitEntry.findMany({ where: { membershipId: ctx.membership.id }, orderBy: { createdAt: 'asc' } }) : [];
  res.json({
    data: snapshots.map((s) => {
      const date = s.date.toISOString().slice(0, 10);
      const cutoff = kathmanduMidnight(addDaysTo(date, 1));
      const units = entries.filter((e) => e.createdAt < cutoff).reduce((sum, e) => sum.add(e.units), ZERO);
      return {
        date,
        navPerUnit: num6(s.navPerUnit),
        totalValue: num(s.totalValue),
        invested: num(s.invested),
        cash: num(s.cash),
        myValue: ctx.membership ? num(units.mul(s.navPerUnit)) : null,
      };
    }),
  });
});

/** Where the money is: by asset type (cash included) and, for listed securities, by sector. */
memberRouter.get('/breakdown', async (req, res) => {
  const state = await currentState(pctx(req).portfolio.id);
  const byType = new Map<string, number>();
  const bySector = new Map<string, number>();
  for (const h of state.holdings) {
    const v = num(h.marketValue);
    if (v <= 0) continue;
    byType.set(h.holding.assetType, (byType.get(h.holding.assetType) ?? 0) + v);
    const sector = h.holding.sector || (h.holding.assetType === 'STOCK' ? 'Unclassified' : h.holding.assetType.replace('_', ' '));
    bySector.set(sector, (bySector.get(sector) ?? 0) + v);
  }
  const cash = num(state.ledger.cash);
  if (cash > 0) {
    byType.set('CASH', cash);
    bySector.set('Cash', cash);
  }
  const toList = (m: Map<string, number>) => [...m.entries()].map(([key, value]) => ({ key, value })).sort((a, b) => b.value - a.value);
  res.json({ data: { byAssetType: toList(byType), bySector: toList(bySector), total: num(state.totalValue) } });
});

// --- deposits ----------------------------------------------------------------

/** What "Pay this month" needs: amount, due date, period and where to pay. */
memberRouter.get('/deposit-info', async (req, res) => {
  const ctx = pctx(req);
  const membership = ownMembership(req);
  const tracker = await contributionTracker(ctx.portfolio, { membershipIds: [membership.id] });
  const cells = tracker.rows[0]?.cells ?? [];
  const outstanding = cells.filter((c) => c.outstanding > 0 && c.status !== 'PENDING');
  // The oldest unpaid month; when everything is paid or awaiting review, the month after the last covered one (paying ahead).
  const oldest = outstanding[0];
  const lastCovered = [...cells].reverse().find((c) => c.status === 'PAID' || c.status === 'PENDING')?.period;
  const ahead = lastCovered ? nextMonth(lastCovered) : kathmanduDate().slice(0, 7);
  const openExit = await prisma.exitRequest.count({ where: { membershipId: membership.id, status: { in: ['REQUESTED', 'APPROVED'] } } });
  res.json({
    data: {
      period: oldest?.period ?? ahead,
      amount: oldest?.outstanding ?? tracker.contributionAmount,
      dueDate: oldest?.dueDate ?? dueDate(ahead, ctx.portfolio.dueDay),
      status: oldest?.status ?? null,
      lateFee: oldest?.lateFee ?? 0,
      outstanding: outstanding.map((c) => ({ period: c.period, amount: c.outstanding, dueDate: c.dueDate, late: c.status === 'LATE' })),
      contributionAmount: tracker.contributionAmount,
      paymentDetails: paymentDetails(ctx.portfolio),
      canDeposit: !openExit && ctx.portfolio.status === 'ACTIVE' && !ctx.readOnly,
    },
  });
});

memberRouter.get('/deposits', async (req, res) => {
  const membership = ownMembership(req);
  const rows = await prisma.deposit.findMany({ where: { membershipId: membership.id }, orderBy: { submittedAt: 'desc' } });
  res.json({ data: rows.map((d) => serializeDeposit(d)) });
});

const depositBody = z.object({
  amount: z.coerce.number().positive().max(1e12),
  period: month,
  method: z.enum(['BANK', 'ESEWA', 'KHALTI', 'OTHER']).default('BANK'),
  reference: z.string().trim().max(120).optional(),
  note: z.string().trim().max(500).optional(),
});

memberRouter.post('/deposits', screenshotUpload, async (req, res) => {
  const ctx = pctx(req);
  const file = req.file;
  try {
    const membership = ownMembership(req);
    const body = depositBody.parse(req.body);
    if (!file) throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Attach a screenshot of the payment');
    if (await prisma.exitRequest.count({ where: { membershipId: membership.id, status: { in: ['REQUESTED', 'APPROVED'] } } })) {
      throw new AppError(409, ErrorCode.INVALID_STATE, 'You have an open exit request');
    }
    const stored = verifyUpload(file);
    const deposit = await prisma.deposit.create({
      data: {
        portfolioId: ctx.portfolio.id,
        membershipId: membership.id,
        amount: new Dec(body.amount),
        period: body.period,
        method: body.method,
        reference: body.reference || null,
        note: body.note || null,
        screenshotPath: stored.storagePath,
        screenshotMime: stored.mime,
        submittedById: req.auth!.user.id,
      },
    });
    await audit(req, {
      portfolioId: ctx.portfolio.id,
      action: 'deposit.submit',
      entityType: 'deposit',
      entityId: deposit.id,
      summary: `${req.auth!.user.name} submitted Rs ${body.amount.toLocaleString('en-IN')} for ${body.period}`,
    });
    res.status(201).json({ data: serializeDeposit(deposit) });
  } catch (err) {
    if (file) discardUpload(file.path);
    throw err;
  }
});

async function visibleDeposit(req: Request) {
  const ctx = pctx(req);
  const deposit = await prisma.deposit.findFirst({ where: { id: idOf(req.params.depositId), portfolioId: ctx.portfolio.id }, include: { membership: { include: { user: true } } } });
  if (!deposit || (!isManager(req) && deposit.membershipId !== ctx.membership?.id)) throw AppError.notFound(ErrorCode.NOT_FOUND, 'Deposit not found');
  return deposit;
}

memberRouter.get('/deposits/:depositId/screenshot', async (req, res) => {
  const deposit = await visibleDeposit(req);
  if (!deposit.screenshotPath || !deposit.screenshotMime) throw AppError.notFound(ErrorCode.NOT_FOUND, 'No screenshot');
  sendStored(res, deposit.screenshotPath, deposit.screenshotMime, `deposit-${deposit.id}`);
});

memberRouter.get('/deposits/:depositId/receipt', async (req, res) => {
  const deposit = await visibleDeposit(req);
  if (deposit.status !== 'APPROVED') throw new AppError(409, ErrorCode.INVALID_STATE, 'Receipts exist only for approved deposits');
  sendReceiptPdf(res, pctx(req).portfolio, deposit.membership.user.name, deposit);
});

// --- contributions -------------------------------------------------------------

memberRouter.get('/contributions', async (req, res) => {
  const ctx = pctx(req);
  const membership = ownMembership(req);
  const tracker = await contributionTracker(ctx.portfolio, { membershipIds: [membership.id] });
  res.json({ data: { ...tracker, rows: undefined, cells: tracker.rows[0]?.cells ?? [], canSeeGroup: ctx.portfolio.membersSeeTracker || isManager(req) } });
});

memberRouter.get('/contributions/group', async (req, res) => {
  const ctx = pctx(req);
  if (!ctx.portfolio.membersSeeTracker && !isManager(req)) throw new AppError(403, ErrorCode.FORBIDDEN, "The admin hasn't shared the group tracker");
  res.json({ data: await contributionTracker(ctx.portfolio) });
});

// --- holdings ------------------------------------------------------------------

memberRouter.get('/holdings', async (req, res) => {
  const state = await currentState(pctx(req).portfolio.id);
  const holdings = state.holdings.filter((h) => !h.holding.archived || h.quantity.gt(0)).map(serializeHolding);
  res.json({ data: { holdings, cash: num(state.ledger.cash), totalValue: num(state.totalValue), marketValue: num(state.marketValue) } });
});

memberRouter.get('/holdings/:holdingId', async (req, res) => {
  const ctx = pctx(req);
  const id = idOf(req.params.holdingId);
  const state = await currentState(ctx.portfolio.id);
  const value = state.holdings.find((h) => h.holding.id === id);
  if (!value) throw AppError.notFound(ErrorCode.NOT_FOUND, 'Asset not found');
  const [documents, txs] = await Promise.all([
    prisma.holdingDocument.findMany({ where: { holdingId: id }, orderBy: { createdAt: 'desc' } }),
    prisma.portfolioTransaction.findMany({ where: { holdingId: id }, orderBy: [{ date: 'desc' }, { id: 'desc' }], include: { holding: true } }),
  ]);
  res.json({
    data: {
      ...serializeHolding(value),
      notes: value.holding.notes,
      weightPercent: state.totalValue.gt(0) ? num(value.marketValue.div(state.totalValue).mul(100)) : 0,
      documents: documents.map((d) => ({ id: d.id, fileName: d.fileName, mime: d.mime, size: d.size, createdAt: d.createdAt.toISOString() })),
      transactions: txs.map(serializeTx),
    },
  });
});

memberRouter.get('/holdings/:holdingId/documents/:docId', async (req, res) => {
  const doc = await prisma.holdingDocument.findFirst({
    where: { id: idOf(req.params.docId), holdingId: idOf(req.params.holdingId), holding: { portfolioId: pctx(req).portfolio.id } },
  });
  if (!doc) throw AppError.notFound(ErrorCode.NOT_FOUND, 'Document not found');
  sendStored(res, doc.storagePath, doc.mime, doc.fileName);
});

// --- activity ------------------------------------------------------------------

/** Read-only feed of what the group did with the money (members' own deposits are on the Deposit page). */
memberRouter.get('/activity', async (req, res) => {
  const { before, limit } = z.object({ before: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query);
  const rows = await prisma.portfolioTransaction.findMany({
    where: { portfolioId: pctx(req).portfolio.id, type: { notIn: ['DEPOSIT'] }, ...(before ? { id: { lt: before } } : {}) },
    orderBy: [{ date: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    include: { holding: true },
  });
  const page = rows.slice(0, limit);
  res.json({ data: page.map(serializeTx), meta: { hasMore: rows.length > limit, nextBefore: rows.length > limit ? page[page.length - 1]!.id : null } });
});

// --- statements ----------------------------------------------------------------

memberRouter.get('/statements', async (req, res) => {
  const m = ownMembership(req);
  res.json({ data: statementMonths(m.joinedAt, m.leftAt) });
});

memberRouter.get('/statements/:month', async (req, res) => {
  const ctx = pctx(req);
  const m = ownMembership(req);
  const which = month.parse(req.params.month);
  const statement = await buildStatement(ctx.portfolio, m.id, which);
  sendStatementPdf(res, [statement], `statement-${ctx.portfolio.id}-${which}.pdf`);
});

// --- exit ----------------------------------------------------------------------

memberRouter.get('/exit', async (req, res) => {
  const ctx = pctx(req);
  const m = ownMembership(req);
  const state = await currentState(ctx.portfolio.id);
  const units = state.unitsByMembership.get(m.id) ?? ZERO;
  const requests = await prisma.exitRequest.findMany({ where: { membershipId: m.id }, orderBy: { requestedAt: 'desc' } });
  res.json({
    data: {
      estimate: { units: num6(units), navPerUnit: num6(state.nav), payout: num(units.mul(state.nav)), asOf: new Date().toISOString() },
      requests: requests.map((e) => serializeExit(e)),
      canRequest: !requests.some((r) => r.status === 'REQUESTED' || r.status === 'APPROVED') && !ctx.readOnly,
    },
  });
});

memberRouter.post('/exit', async (req, res) => {
  const ctx = pctx(req);
  const { reason } = z.object({ reason: z.string().trim().max(500).optional() }).parse(req.body ?? {});
  const exit = await requestExit(req, ctx.portfolio, ownMembership(req), reason || undefined);
  res.status(201).json({ data: serializeExit(exit) });
});

memberRouter.post('/exit/:exitId/cancel', async (req, res) => {
  const ctx = pctx(req);
  const m = ownMembership(req);
  const exit = await prisma.exitRequest.findFirst({ where: { id: idOf(req.params.exitId), membershipId: m.id } });
  if (!exit) throw AppError.notFound(ErrorCode.NOT_FOUND, 'Exit request not found');
  if (exit.status !== 'REQUESTED') throw new AppError(409, ErrorCode.INVALID_STATE, 'Only a request that has not been approved can be cancelled');
  const updated = await prisma.exitRequest.update({ where: { id: exit.id }, data: { status: 'CANCELLED' } });
  await audit(req, { portfolioId: ctx.portfolio.id, action: 'exit.cancel', entityType: 'exit', entityId: exit.id, summary: `${req.auth!.user.name} cancelled their exit request` });
  res.json({ data: serializeExit(updated) });
});

// --- members -------------------------------------------------------------------

memberRouter.get('/members', async (req, res) => {
  const ctx = pctx(req);
  const showShares = ctx.portfolio.membersSeeShares || isManager(req);
  const state = showShares ? await currentState(ctx.portfolio.id) : null;
  const members = await prisma.membership.findMany({ where: { portfolioId: ctx.portfolio.id, status: 'ACTIVE' }, include: { user: true }, orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }] });
  res.json({
    data: {
      showShares,
      members: members.map((m) => {
        const units = state?.unitsByMembership.get(m.id) ?? ZERO;
        return {
          membershipId: m.id,
          userId: m.userId,
          name: m.user.name,
          role: m.role,
          joinedAt: m.joinedAt.toISOString(),
          isMe: m.userId === req.auth!.user.id,
          ...(state
            ? { units: num6(units), ownershipPercent: state.totalUnits.gt(0) ? num(units.div(state.totalUnits).mul(100)) : 0, value: num(units.mul(state.nav)) }
            : {}),
        };
      }),
    },
  });
});
