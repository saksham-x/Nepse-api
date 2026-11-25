import { Router, type RequestHandler } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../config/prisma.js';
import { AppError, ErrorCode } from '../../common/errors/app-error.js';
import { discardUpload, documentUpload, removeStored, verifyUpload } from '../../common/uploads.js';
import { kathmanduDate, tradeDateToDb } from '../../common/utils/time.js';
import { audit, serializeAudit } from '../audit/audit.js';
import { getIngestionService } from '../ingestion/ingestion.service.js';
import { notify } from '../notifications/notify.js';
import { Dec, ZERO } from './ledger.js';
import { paymentDetails, portfolioInfo, serializeDeposit, serializeExit, serializeHolding } from './member.routes.js';
import { idOf, pctx, portfolioAccess } from './portfolio.access.js';
import {
  approveDeposit,
  approveExit,
  contributionTracker,
  createManualDeposit,
  createTransaction,
  markExitPaid,
  MANUAL_TYPES,
  rejectDeposit,
  rejectExit,
  reverseTransaction,
  sendReminders,
  serializeTx,
  updateTransaction,
} from './portfolio.operations.js';
import { applyNepsePrices, capitalByMembership, computeState, currentState, groupTotals, lockPortfolio, memberNumbers, num, recordSnapshot } from './portfolio.service.js';
import { buildStatement, sendStatementPdf, sendStatementsXlsx } from './statements.js';

export const adminRouter = Router({ mergeParams: true });
adminRouter.use(portfolioAccess('LEADER'));

const adminOnly: RequestHandler = (req, _res, next) => {
  next(pctx(req).role === 'ADMIN' ? undefined : new AppError(403, ErrorCode.FORBIDDEN, 'Only the portfolio admin can do this'));
};

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be YYYY-MM');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD');
const note = z.string().trim().min(3, 'A note is required').max(500);
const money = z.number().finite().min(-1e12).max(1e12);

// --- dashboard -----------------------------------------------------------------

adminRouter.get('/dashboard', async (req, res) => {
  const ctx = pctx(req);
  const state = await currentState(ctx.portfolio.id);
  const [pendingDeposits, pendingExits, tracker, members, recent] = await Promise.all([
    prisma.deposit.count({ where: { portfolioId: ctx.portfolio.id, status: 'PENDING' } }),
    prisma.exitRequest.count({ where: { portfolioId: ctx.portfolio.id, status: { in: ['REQUESTED', 'APPROVED'] } } }),
    contributionTracker(ctx.portfolio),
    prisma.membership.count({ where: { portfolioId: ctx.portfolio.id, status: 'ACTIVE' } }),
    prisma.auditLog.findMany({ where: { portfolioId: ctx.portfolio.id }, orderBy: { id: 'desc' }, take: 8 }),
  ]);
  const latePayers = tracker.rows
    .filter((r) => r.lateCount > 0)
    .map((r) => ({ membershipId: r.membershipId, name: r.name, lateMonths: r.cells.filter((c) => c.status === 'LATE').map((c) => c.period), outstanding: r.outstanding }))
    .sort((a, b) => b.outstanding - a.outstanding);
  res.json({
    data: {
      portfolio: portfolioInfo(ctx.portfolio),
      role: ctx.role,
      readOnly: ctx.readOnly,
      totals: groupTotals(state),
      memberCount: members,
      pendingDeposits,
      pendingExits,
      latePayers,
      recentActivity: recent.map(serializeAudit),
    },
  });
});

// --- members -------------------------------------------------------------------

adminRouter.get('/members', async (req, res) => {
  const ctx = pctx(req);
  const state = await currentState(ctx.portfolio.id);
  const capital = await capitalByMembership(ctx.portfolio.id);
  const tracker = await contributionTracker(ctx.portfolio);
  const lateBy = new Map(tracker.rows.map((r) => [r.membershipId, r]));
  const members = await prisma.membership.findMany({ where: { portfolioId: ctx.portfolio.id }, include: { user: true }, orderBy: [{ status: 'asc' }, { joinedAt: 'asc' }] });
  const invitations = await prisma.invitation.findMany({ where: { portfolioId: ctx.portfolio.id, status: 'PENDING' }, orderBy: { createdAt: 'desc' } });
  res.json({
    data: {
      members: members.map((m) => ({
        membershipId: m.id,
        userId: m.userId,
        name: m.user.name,
        email: m.user.email,
        phone: m.user.phone,
        role: m.role,
        status: m.status,
        joinedAt: m.joinedAt.toISOString(),
        leftAt: m.leftAt?.toISOString() ?? null,
        ...memberNumbers(state, m.id, capital.contributed.get(m.id) ?? ZERO, capital.paidOut.get(m.id)),
        lateMonths: lateBy.get(m.id)?.lateCount ?? 0,
        outstanding: lateBy.get(m.id)?.outstanding ?? 0,
      })),
      invitations: invitations.map((i) => ({ id: i.id, email: i.email, role: i.role, createdAt: i.createdAt.toISOString() })),
    },
  });
});

adminRouter.get('/members/:membershipId', async (req, res) => {
  const ctx = pctx(req);
  const m = await prisma.membership.findFirst({ where: { id: idOf(req.params.membershipId), portfolioId: ctx.portfolio.id }, include: { user: true } });
  if (!m) throw AppError.notFound(ErrorCode.NOT_FOUND, 'Member not found');
  const state = await currentState(ctx.portfolio.id);
  const capital = await capitalByMembership(ctx.portfolio.id);
  const [deposits, units, exits, tracker] = await Promise.all([
    prisma.deposit.findMany({ where: { membershipId: m.id }, orderBy: { submittedAt: 'desc' } }),
    prisma.unitEntry.findMany({ where: { membershipId: m.id }, orderBy: { createdAt: 'desc' } }),
    prisma.exitRequest.findMany({ where: { membershipId: m.id }, orderBy: { requestedAt: 'desc' } }),
    contributionTracker(ctx.portfolio, { membershipIds: [m.id] }),
  ]);
  res.json({
    data: {
      membershipId: m.id,
      userId: m.userId,
      name: m.user.name,
      email: m.user.email,
      phone: m.user.phone,
      role: m.role,
      status: m.status,
      joinedAt: m.joinedAt.toISOString(),
      numbers: memberNumbers(state, m.id, capital.contributed.get(m.id) ?? ZERO, capital.paidOut.get(m.id)),
      deposits: deposits.map((d) => serializeDeposit(d, m.user.name)),
      unitEntries: units.map((u) => ({ id: u.id, kind: u.kind, units: Number(u.units.toFixed(6)), nav: Number(u.nav.toFixed(6)), amount: num(u.amount), createdAt: u.createdAt.toISOString() })),
      exits: exits.map((e) => serializeExit(e, m.user.name)),
      contributions: tracker.rows[0]?.cells ?? [],
    },
  });
});

adminRouter.post('/invitations', adminOnly, async (req, res) => {
  const ctx = pctx(req);
  const body = z.object({ email: z.string().trim().toLowerCase().email(), role: z.enum(['ADMIN', 'LEADER', 'MEMBER']).default('MEMBER') }).parse(req.body);
  if (ctx.portfolio.type === 'SOLO') throw new AppError(409, ErrorCode.INVALID_STATE, 'Solo portfolios have only one member. Change the type in Settings first.');
  const user = await prisma.user.findUnique({ where: { email: body.email } });
  if (user) {
    const existing = await prisma.membership.findUnique({ where: { portfolioId_userId: { portfolioId: ctx.portfolio.id, userId: user.id } } });
    if (existing?.status === 'ACTIVE') throw new AppError(409, ErrorCode.INVALID_STATE, 'That person is already a member');
  }
  if (await prisma.invitation.findFirst({ where: { portfolioId: ctx.portfolio.id, email: body.email, status: 'PENDING' } })) {
    throw new AppError(409, ErrorCode.INVALID_STATE, 'That email already has a pending invitation');
  }
  const inv = await prisma.invitation.create({ data: { portfolioId: ctx.portfolio.id, email: body.email, role: body.role, invitedById: req.auth!.user.id } });
  if (user) {
    await notify([user.id], { type: 'INVITATION', portfolioId: ctx.portfolio.id, title: `You're invited to ${ctx.portfolio.name}`, body: `${req.auth!.user.name} invited you as ${body.role.toLowerCase()}.`, link: '/app' });
  }
  await audit(req, { portfolioId: ctx.portfolio.id, action: 'member.invite', entityType: 'invitation', entityId: inv.id, summary: `Invited ${body.email} as ${body.role.toLowerCase()}` });
  res.status(201).json({ data: { id: inv.id, email: inv.email, role: inv.role, createdAt: inv.createdAt.toISOString(), userExists: !!user } });
});

adminRouter.delete('/invitations/:invitationId', adminOnly, async (req, res) => {
  const ctx = pctx(req);
  const inv = await prisma.invitation.findFirst({ where: { id: idOf(req.params.invitationId), portfolioId: ctx.portfolio.id, status: 'PENDING' } });
  if (!inv) throw AppError.notFound(ErrorCode.NOT_FOUND, 'Invitation not found');
  await prisma.invitation.update({ where: { id: inv.id }, data: { status: 'REVOKED', respondedAt: new Date() } });
  await audit(req, { portfolioId: ctx.portfolio.id, action: 'member.invite_revoke', entityType: 'invitation', entityId: inv.id, summary: `Revoked the invitation for ${inv.email}` });
  res.status(204).end();
});

async function activeMember(portfolioId: number, membershipId: number) {
  const m = await prisma.membership.findFirst({ where: { id: membershipId, portfolioId, status: 'ACTIVE' }, include: { user: true } });
  if (!m) throw AppError.notFound(ErrorCode.NOT_FOUND, 'Member not found');
  return m;
}

async function assertAnotherAdmin(portfolioId: number, membershipId: number) {
  const admins = await prisma.membership.count({ where: { portfolioId, status: 'ACTIVE', role: 'ADMIN', id: { not: membershipId } } });
  if (admins === 0) throw new AppError(409, ErrorCode.INVALID_STATE, 'A portfolio needs at least one admin');
}

adminRouter.patch('/members/:membershipId', adminOnly, async (req, res) => {
  const ctx = pctx(req);
  const { role } = z.object({ role: z.enum(['ADMIN', 'LEADER', 'MEMBER']) }).parse(req.body);
  const m = await activeMember(ctx.portfolio.id, idOf(req.params.membershipId));
  if (m.role === 'ADMIN' && role !== 'ADMIN') await assertAnotherAdmin(ctx.portfolio.id, m.id);
  await prisma.membership.update({ where: { id: m.id }, data: { role } });
  await audit(req, { portfolioId: ctx.portfolio.id, action: 'member.role', entityType: 'membership', entityId: m.id, summary: `Changed ${m.user.name}'s role from ${m.role.toLowerCase()} to ${role.toLowerCase()}` });
  res.status(204).end();
});

/** Removing is for members with no units. Members who hold units leave through an exit, which pays them out. */
adminRouter.delete('/members/:membershipId', adminOnly, async (req, res) => {
  const ctx = pctx(req);
  const m = await activeMember(ctx.portfolio.id, idOf(req.params.membershipId));
  if (m.role === 'ADMIN') await assertAnotherAdmin(ctx.portfolio.id, m.id);
  const units = await prisma.unitEntry.aggregate({ where: { membershipId: m.id }, _sum: { units: true } });
  if ((units._sum.units ?? ZERO).gt(0)) throw new AppError(409, ErrorCode.INVALID_STATE, `${m.user.name} holds units. Process an exit so they are paid out first.`);
  await prisma.$transaction([
    prisma.membership.update({ where: { id: m.id }, data: { status: 'REMOVED', leftAt: new Date() } }),
    prisma.deposit.updateMany({ where: { membershipId: m.id, status: 'PENDING' }, data: { status: 'REJECTED', rejectionReason: 'Member removed from the portfolio', reviewedAt: new Date(), reviewedById: req.auth!.user.id } }),
  ]);
  await audit(req, { portfolioId: ctx.portfolio.id, action: 'member.remove', entityType: 'membership', entityId: m.id, summary: `Removed ${m.user.name}` });
  res.status(204).end();
});

// --- deposits ------------------------------------------------------------------

adminRouter.get('/deposits', async (req, res) => {
  const ctx = pctx(req);
  const { status } = z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional() }).parse(req.query);
  const rows = await prisma.deposit.findMany({
    where: { portfolioId: ctx.portfolio.id, ...(status ? { status } : {}) },
    include: { membership: { include: { user: true } } },
    orderBy: status === 'PENDING' ? { submittedAt: 'asc' } : { submittedAt: 'desc' },
    take: 300,
  });
  res.json({ data: rows.map((d) => serializeDeposit(d, d.membership.user.name)) });
});

adminRouter.post('/deposits/:depositId/approve', async (req, res) => {
  const d = await approveDeposit(req, pctx(req).portfolio, idOf(req.params.depositId));
  res.json({ data: serializeDeposit(d) });
});

adminRouter.post('/deposits/:depositId/reject', async (req, res) => {
  const { reason } = z.object({ reason: z.string().trim().min(3, 'Give the member a reason').max(500) }).parse(req.body);
  const d = await rejectDeposit(req, pctx(req).portfolio, idOf(req.params.depositId), reason);
  res.json({ data: serializeDeposit(d) });
});

adminRouter.post('/deposits/manual', async (req, res) => {
  const body = z
    .object({
      membershipId: z.number().int().positive(),
      amount: z.number().positive().max(1e12),
      period: month,
      method: z.enum(['CASH', 'BANK', 'ESEWA', 'KHALTI', 'OTHER']).default('CASH'),
      reference: z.string().trim().max(120).optional(),
      note: z.string().trim().max(500).optional(),
      receivedOn: date.refine((d) => d <= kathmanduDate(), 'Received date cannot be in the future').optional(),
    })
    .parse(req.body);
  const d = await createManualDeposit(req, pctx(req).portfolio, body);
  res.status(201).json({ data: serializeDeposit(d) });
});

// --- contribution tracker --------------------------------------------------------

adminRouter.get('/tracker', async (req, res) => {
  const q = z.object({ from: month.optional(), to: month.optional() }).parse(req.query);
  res.json({ data: await contributionTracker(pctx(req).portfolio, q) });
});

adminRouter.post('/reminders', async (req, res) => {
  const { membershipIds } = z.object({ membershipIds: z.array(z.number().int().positive()).min(1).max(500) }).parse(req.body);
  res.json({ data: await sendReminders(req, pctx(req).portfolio, membershipIds) });
});

// --- holdings ------------------------------------------------------------------

const ASSET_TYPES = ['STOCK', 'MUTUAL_FUND', 'BOND', 'FIXED_DEPOSIT', 'GOLD', 'REAL_ESTATE', 'CRYPTO', 'OTHER'] as const;
const holdingBody = z.object({
  assetType: z.enum(ASSET_TYPES),
  symbol: z.string().trim().toUpperCase().max(20).nullable().optional(),
  name: z.string().trim().min(1).max(160),
  sector: z.string().trim().max(120).nullable().optional(),
  currentPrice: z.number().min(0).max(1e12).optional(),
  priceSource: z.enum(['MANUAL', 'NEPSE']).default('MANUAL'),
  notes: z.string().max(20_000).nullable().optional(),
  archived: z.boolean().optional(),
});

async function checkNepseSymbol(symbol: string | null | undefined, source: string) {
  if (source !== 'NEPSE') return null;
  if (!symbol) throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'NEPSE pricing needs a symbol');
  const instrument = await prisma.instrument.findUnique({ where: { symbol }, include: { quote: true } });
  if (!instrument) throw new AppError(400, ErrorCode.VALIDATION_ERROR, `Unknown NEPSE symbol '${symbol}'`);
  return instrument;
}

adminRouter.get('/holdings', async (req, res) => {
  const state = await currentState(pctx(req).portfolio.id);
  res.json({ data: { holdings: state.holdings.map(serializeHolding), cash: num(state.ledger.cash), totalValue: num(state.totalValue), marketValue: num(state.marketValue) } });
});

adminRouter.post('/holdings', adminOnly, async (req, res) => {
  const ctx = pctx(req);
  const body = holdingBody.parse(req.body);
  const instrument = await checkNepseSymbol(body.symbol, body.priceSource);
  const h = await prisma.holding.create({
    data: {
      portfolioId: ctx.portfolio.id,
      assetType: body.assetType,
      symbol: body.symbol || null,
      name: body.name,
      sector: body.sector || instrument?.sector || null,
      currentPrice: new Dec(body.currentPrice ?? instrument?.quote?.lastTradedPrice.toNumber() ?? 0),
      priceSource: body.priceSource,
      priceUpdatedAt: new Date(),
      notes: body.notes ?? null,
    },
  });
  await audit(req, { portfolioId: ctx.portfolio.id, action: 'holding.create', entityType: 'holding', entityId: h.id, summary: `Added asset ${h.name} (${h.assetType.toLowerCase()})` });
  res.status(201).json({ data: { id: h.id } });
});

adminRouter.patch('/holdings/:holdingId', adminOnly, async (req, res) => {
  const ctx = pctx(req);
  const before = await prisma.holding.findFirst({ where: { id: idOf(req.params.holdingId), portfolioId: ctx.portfolio.id } });
  if (!before) throw AppError.notFound(ErrorCode.NOT_FOUND, 'Asset not found');
  const body = holdingBody.partial().parse(req.body);
  const source = body.priceSource ?? before.priceSource;
  if (body.priceSource || body.symbol !== undefined) await checkNepseSymbol(body.symbol !== undefined ? body.symbol : before.symbol, source);
  const data: Prisma.HoldingUpdateInput = {};
  if (body.assetType) data.assetType = body.assetType;
  if (body.symbol !== undefined) data.symbol = body.symbol || null;
  if (body.name) data.name = body.name;
  if (body.sector !== undefined) data.sector = body.sector || null;
  if (body.priceSource) data.priceSource = body.priceSource;
  if (body.notes !== undefined) data.notes = body.notes;
  if (body.archived !== undefined) data.archived = body.archived;
  if (body.currentPrice !== undefined) {
    data.currentPrice = new Dec(body.currentPrice);
    data.priceUpdatedAt = new Date();
  }
  await prisma.holding.update({ where: { id: before.id }, data });
  await recordSnapshot(await computeState(ctx.portfolio.id));
  await audit(req, { portfolioId: ctx.portfolio.id, action: 'holding.edit', entityType: 'holding', entityId: before.id, summary: `Edited asset ${before.name}`, data: { changes: JSON.parse(JSON.stringify(body)) } });
  res.status(204).end();
});

/** Manual price update. Leaders may do this too. */
adminRouter.post('/holdings/:holdingId/price', async (req, res) => {
  const ctx = pctx(req);
  const { price } = z.object({ price: z.number().min(0).max(1e12) }).parse(req.body);
  const h = await prisma.holding.findFirst({ where: { id: idOf(req.params.holdingId), portfolioId: ctx.portfolio.id } });
  if (!h) throw AppError.notFound(ErrorCode.NOT_FOUND, 'Asset not found');
  await prisma.holding.update({ where: { id: h.id }, data: { currentPrice: new Dec(price), priceUpdatedAt: new Date(), priceSource: 'MANUAL' } });
  await recordSnapshot(await computeState(ctx.portfolio.id));
  await audit(req, { portfolioId: ctx.portfolio.id, action: 'holding.price', entityType: 'holding', entityId: h.id, summary: `Set ${h.name} price from ${h.currentPrice.toFixed(2)} to ${price.toFixed(2)}` });
  res.status(204).end();
});

/**
 * NEPSE auto-sync: optionally refetches the portfolio's symbols from NEPSE
 * (`refresh: true`), then copies the stored quotes into NEPSE-priced holdings.
 */
adminRouter.post('/holdings/sync-prices', async (req, res) => {
  const ctx = pctx(req);
  const { refresh } = z.object({ refresh: z.boolean().default(false) }).parse(req.body ?? {});
  const failures: string[] = [];
  if (refresh) {
    const holdings = await prisma.holding.findMany({ where: { portfolioId: ctx.portfolio.id, priceSource: 'NEPSE', symbol: { not: null } }, select: { symbol: true } });
    const instruments = await prisma.instrument.findMany({ where: { symbol: { in: holdings.map((h) => h.symbol!) } } });
    for (const inst of instruments) {
      try {
        await getIngestionService().refreshInstrument(inst);
      } catch {
        failures.push(inst.symbol);
      }
    }
  }
  const updated = await applyNepsePrices(ctx.portfolio.id);
  await recordSnapshot(await computeState(ctx.portfolio.id));
  await audit(req, { portfolioId: ctx.portfolio.id, action: 'holding.sync_prices', summary: `Synced NEPSE prices: ${updated} updated${failures.length ? `, failed: ${failures.join(', ')}` : ''}` });
  res.json({ data: { updated, failed: failures } });
});

adminRouter.post('/holdings/:holdingId/documents', adminOnly, documentUpload, async (req, res) => {
  const ctx = pctx(req);
  const file = req.file;
  try {
    const h = await prisma.holding.findFirst({ where: { id: idOf(req.params.holdingId), portfolioId: ctx.portfolio.id } });
    if (!h) throw AppError.notFound(ErrorCode.NOT_FOUND, 'Asset not found');
    if (!file) throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Choose a file');
    const stored = verifyUpload(file);
    const fileName = (Buffer.from(file.originalname, 'latin1').toString('utf8') || 'document').slice(0, 200);
    const doc = await prisma.holdingDocument.create({ data: { holdingId: h.id, fileName, storagePath: stored.storagePath, mime: stored.mime, size: file.size, uploadedById: req.auth!.user.id } });
    await audit(req, { portfolioId: ctx.portfolio.id, action: 'holding.document_add', entityType: 'holding', entityId: h.id, summary: `Attached "${fileName}" to ${h.name}` });
    res.status(201).json({ data: { id: doc.id, fileName: doc.fileName } });
  } catch (err) {
    if (file) discardUpload(file.path);
    throw err;
  }
});

adminRouter.delete('/holdings/:holdingId/documents/:docId', adminOnly, async (req, res) => {
  const ctx = pctx(req);
  const doc = await prisma.holdingDocument.findFirst({ where: { id: idOf(req.params.docId), holdingId: idOf(req.params.holdingId), holding: { portfolioId: ctx.portfolio.id } }, include: { holding: true } });
  if (!doc) throw AppError.notFound(ErrorCode.NOT_FOUND, 'Document not found');
  await prisma.holdingDocument.delete({ where: { id: doc.id } });
  removeStored(doc.storagePath);
  await audit(req, { portfolioId: ctx.portfolio.id, action: 'holding.document_remove', entityType: 'holding', entityId: doc.holdingId, summary: `Removed "${doc.fileName}" from ${doc.holding.name}` });
  res.status(204).end();
});

// --- transactions --------------------------------------------------------------

const txBody = z.object({
  type: z.enum(MANUAL_TYPES),
  date,
  holdingId: z.number().int().positive().nullable().optional(),
  quantity: z.number().positive().max(1e12).nullable().optional(),
  price: z.number().positive().max(1e12).nullable().optional(),
  amount: money.nullable().optional(),
  fees: z.number().min(0).max(1e12).optional(),
  note,
});

adminRouter.get('/transactions', async (req, res) => {
  const ctx = pctx(req);
  const q = z.object({ type: z.string().optional(), holdingId: z.coerce.number().int().optional(), includeReversed: z.enum(['true', 'false']).default('true') }).parse(req.query);
  const rows = await prisma.portfolioTransaction.findMany({
    where: {
      portfolioId: ctx.portfolio.id,
      ...(q.type ? { type: q.type as never } : {}),
      ...(q.holdingId ? { holdingId: q.holdingId } : {}),
      ...(q.includeReversed === 'false' ? { status: 'ACTIVE' } : {}),
    },
    orderBy: [{ date: 'desc' }, { id: 'desc' }],
    include: { holding: true },
    take: 500,
  });
  res.json({ data: rows.map(serializeTx) });
});

adminRouter.post('/transactions', adminOnly, async (req, res) => {
  const tx = await createTransaction(req, pctx(req).portfolio, txBody.parse(req.body));
  res.status(201).json({ data: serializeTx(tx) });
});

adminRouter.patch('/transactions/:txId', adminOnly, async (req, res) => {
  const tx = await updateTransaction(req, pctx(req).portfolio, idOf(req.params.txId), txBody.parse(req.body));
  res.json({ data: serializeTx(tx) });
});

adminRouter.post('/transactions/:txId/reverse', adminOnly, async (req, res) => {
  const { note: n } = z.object({ note }).parse(req.body);
  const tx = await reverseTransaction(req, pctx(req).portfolio, idOf(req.params.txId), n);
  res.json({ data: serializeTx(tx) });
});

// --- cash ----------------------------------------------------------------------

const accountBody = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(['BANK', 'BROKER', 'ESEWA', 'CASH', 'OTHER']),
  accountRef: z.string().trim().max(120).nullable().optional(),
  balance: money.optional(),
  balanceAsOf: date.optional(),
});

adminRouter.get('/cash', adminOnly, async (req, res) => {
  const ctx = pctx(req);
  const state = await computeState(ctx.portfolio.id);
  const [accounts, recs, flows] = await Promise.all([
    prisma.cashAccount.findMany({ where: { portfolioId: ctx.portfolio.id }, orderBy: { name: 'asc' } }),
    prisma.cashReconciliation.findMany({ where: { portfolioId: ctx.portfolio.id }, orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.portfolioTransaction.findMany({ where: { portfolioId: ctx.portfolio.id, status: 'ACTIVE' }, orderBy: [{ date: 'desc' }, { id: 'desc' }], take: 30, include: { holding: true } }),
  ]);
  const reported = accounts.reduce((s, a) => s.add(a.balance), ZERO);
  res.json({
    data: {
      bookBalance: num(state.ledger.cash),
      reportedBalance: num(reported),
      difference: num(reported.sub(state.ledger.cash)),
      accounts: accounts.map((a) => ({ id: a.id, name: a.name, kind: a.kind, accountRef: a.accountRef, balance: num(a.balance), balanceAsOf: a.balanceAsOf?.toISOString().slice(0, 10) ?? null })),
      reconciliations: recs.map((r) => ({
        id: r.id,
        date: r.date.toISOString().slice(0, 10),
        bookBalance: num(r.bookBalance),
        reportedBalance: num(r.reportedBalance),
        difference: num(r.difference),
        adjustmentTxId: r.adjustmentTxId,
        note: r.note,
        createdAt: r.createdAt.toISOString(),
      })),
      recentFlows: flows.map(serializeTx),
      paymentDetails: paymentDetails(ctx.portfolio),
    },
  });
});

adminRouter.post('/cash/accounts', adminOnly, async (req, res) => {
  const ctx = pctx(req);
  const b = accountBody.parse(req.body);
  const a = await prisma.cashAccount.create({
    data: { portfolioId: ctx.portfolio.id, name: b.name, kind: b.kind, accountRef: b.accountRef ?? null, balance: new Dec(b.balance ?? 0), balanceAsOf: b.balanceAsOf ? tradeDateToDb(b.balanceAsOf) : null },
  });
  await audit(req, { portfolioId: ctx.portfolio.id, action: 'cash.account_add', entityType: 'cash_account', entityId: a.id, summary: `Added cash account ${a.name}` });
  res.status(201).json({ data: { id: a.id } });
});

adminRouter.patch('/cash/accounts/:accountId', adminOnly, async (req, res) => {
  const ctx = pctx(req);
  const a = await prisma.cashAccount.findFirst({ where: { id: idOf(req.params.accountId), portfolioId: ctx.portfolio.id } });
  if (!a) throw AppError.notFound(ErrorCode.NOT_FOUND, 'Account not found');
  const b = accountBody.partial().parse(req.body);
  await prisma.cashAccount.update({
    where: { id: a.id },
    data: {
      ...(b.name ? { name: b.name } : {}),
      ...(b.kind ? { kind: b.kind } : {}),
      ...(b.accountRef !== undefined ? { accountRef: b.accountRef } : {}),
      ...(b.balance !== undefined ? { balance: new Dec(b.balance), balanceAsOf: tradeDateToDb(b.balanceAsOf ?? kathmanduDate()) } : {}),
    },
  });
  await audit(req, {
    portfolioId: ctx.portfolio.id,
    action: 'cash.account_edit',
    entityType: 'cash_account',
    entityId: a.id,
    summary: b.balance !== undefined ? `Updated ${a.name} balance from ${a.balance.toFixed(2)} to ${b.balance.toFixed(2)}` : `Edited cash account ${a.name}`,
  });
  res.status(204).end();
});

adminRouter.delete('/cash/accounts/:accountId', adminOnly, async (req, res) => {
  const ctx = pctx(req);
  const a = await prisma.cashAccount.findFirst({ where: { id: idOf(req.params.accountId), portfolioId: ctx.portfolio.id } });
  if (!a) throw AppError.notFound(ErrorCode.NOT_FOUND, 'Account not found');
  await prisma.cashAccount.delete({ where: { id: a.id } });
  await audit(req, { portfolioId: ctx.portfolio.id, action: 'cash.account_remove', entityType: 'cash_account', entityId: a.id, summary: `Removed cash account ${a.name}` });
  res.status(204).end();
});

/**
 * Reconciliation: records book cash against the accounts' reported balances.
 * With `postAdjustment`, an ADJUSTMENT transaction brings book cash in line.
 */
adminRouter.post('/cash/reconcile', adminOnly, async (req, res) => {
  const ctx = pctx(req);
  const { note: n, postAdjustment } = z.object({ note, postAdjustment: z.boolean().default(false) }).parse(req.body);
  const rec = await prisma.$transaction(async (db) => {
    await lockPortfolio(db, ctx.portfolio.id);
    const state = await computeState(ctx.portfolio.id, db);
    const accounts = await db.cashAccount.findMany({ where: { portfolioId: ctx.portfolio.id } });
    const reported = accounts.reduce((s, a) => s.add(a.balance), ZERO);
    const difference = reported.sub(state.ledger.cash);
    let adjustmentTxId: number | null = null;
    if (postAdjustment && !difference.isZero()) {
      const tx = await db.portfolioTransaction.create({
        data: { portfolioId: ctx.portfolio.id, type: 'ADJUSTMENT', date: tradeDateToDb(kathmanduDate()), amount: difference, note: `Reconciliation: ${n}`, createdById: req.auth!.user.id },
      });
      adjustmentTxId = tx.id;
      await recordSnapshot(await computeState(ctx.portfolio.id, db), db);
    }
    const r = await db.cashReconciliation.create({
      data: { portfolioId: ctx.portfolio.id, date: tradeDateToDb(kathmanduDate()), bookBalance: state.ledger.cash, reportedBalance: reported, difference, adjustmentTxId, note: n, createdById: req.auth!.user.id },
    });
    await audit(req, {
      portfolioId: ctx.portfolio.id,
      action: 'cash.reconcile',
      entityType: 'reconciliation',
      entityId: r.id,
      summary: `Reconciled cash: book ${state.ledger.cash.toFixed(2)}, reported ${reported.toFixed(2)}, difference ${difference.toFixed(2)}${adjustmentTxId ? ' (adjustment posted)' : ''}. ${n}`,
    }, db);
    return r;
  });
  res.status(201).json({ data: { id: rec.id, difference: num(rec.difference), adjustmentTxId: rec.adjustmentTxId } });
});

// --- exits ---------------------------------------------------------------------

adminRouter.get('/exits', adminOnly, async (req, res) => {
  const ctx = pctx(req);
  const state = await currentState(ctx.portfolio.id);
  const rows = await prisma.exitRequest.findMany({ where: { portfolioId: ctx.portfolio.id }, include: { membership: { include: { user: true } } }, orderBy: { requestedAt: 'desc' } });
  res.json({
    data: rows.map((e) => {
      const units = state.unitsByMembership.get(e.membershipId) ?? ZERO;
      return { ...serializeExit(e, e.membership.user.name), currentUnits: Number(units.toFixed(6)), estimateAtCurrentNav: num(units.mul(state.nav)), currentNav: Number(state.nav.toFixed(6)) };
    }),
  });
});

adminRouter.post('/exits/:exitId/approve', adminOnly, async (req, res) => {
  res.json({ data: serializeExit(await approveExit(req, pctx(req).portfolio, idOf(req.params.exitId))) });
});

adminRouter.post('/exits/:exitId/reject', adminOnly, async (req, res) => {
  const { reason } = z.object({ reason: z.string().trim().min(3).max(500) }).parse(req.body);
  res.json({ data: serializeExit(await rejectExit(req, pctx(req).portfolio, idOf(req.params.exitId), reason)) });
});

adminRouter.post('/exits/:exitId/paid', adminOnly, async (req, res) => {
  const { reference } = z.object({ reference: z.string().trim().max(120).optional() }).parse(req.body ?? {});
  res.json({ data: serializeExit(await markExitPaid(req, pctx(req).portfolio, idOf(req.params.exitId), reference || undefined)) });
});

// --- reports -------------------------------------------------------------------

adminRouter.get('/reports/statement', async (req, res) => {
  const ctx = pctx(req);
  const q = z.object({ month, membershipId: z.coerce.number().int().positive().optional(), format: z.enum(['pdf', 'xlsx']).default('pdf') }).parse(req.query);
  const memberships = await prisma.membership.findMany({
    where: { portfolioId: ctx.portfolio.id, ...(q.membershipId ? { id: q.membershipId } : { status: 'ACTIVE' }) },
    orderBy: { joinedAt: 'asc' },
  });
  if (memberships.length === 0) throw AppError.notFound(ErrorCode.NOT_FOUND, 'No members to report on');
  const statements = [];
  for (const m of memberships) statements.push(await buildStatement(ctx.portfolio, m.id, q.month));
  const base = `statements-${ctx.portfolio.id}-${q.month}${q.membershipId ? `-m${q.membershipId}` : ''}`;
  await audit(req, { portfolioId: ctx.portfolio.id, action: 'report.generate', summary: `Generated ${q.format.toUpperCase()} statements for ${q.month} (${memberships.length} member(s))` });
  if (q.format === 'xlsx') await sendStatementsXlsx(res, statements, `${base}.xlsx`);
  else sendStatementPdf(res, statements, `${base}.pdf`);
});

// --- settings ------------------------------------------------------------------

const settingsBody = z.object({
  name: z.string().trim().min(2).max(120),
  type: z.enum(['GROUP', 'SOLO', 'MANAGED']),
  contributionAmount: z.number().min(0).max(1e12),
  dueDay: z.number().int().min(1).max(28),
  graceDays: z.number().int().min(0).max(60),
  lateFee: z.number().min(0).max(1e12),
  startMonth: month,
  membersSeeTracker: z.boolean(),
  membersSeeShares: z.boolean(),
  paymentDetails: z.object({
    bankName: z.string().trim().max(120).nullable(),
    accountName: z.string().trim().max(120).nullable(),
    accountNumber: z.string().trim().max(60).nullable(),
    branch: z.string().trim().max(120).nullable(),
    esewaId: z.string().trim().max(60).nullable(),
    esewaName: z.string().trim().max(120).nullable(),
    instructions: z.string().trim().max(1000).nullable(),
  }).partial(),
}).partial();

adminRouter.get('/settings', async (req, res) => {
  const p = pctx(req).portfolio;
  res.json({ data: { ...portfolioInfo(p), paymentDetails: paymentDetails(p) } });
});

adminRouter.patch('/settings', adminOnly, async (req, res) => {
  const ctx = pctx(req);
  const b = settingsBody.parse(req.body);
  if (b.type === 'SOLO' && ctx.portfolio.type !== 'SOLO') {
    const others = await prisma.membership.count({ where: { portfolioId: ctx.portfolio.id, status: 'ACTIVE' } });
    if (others > 1) throw new AppError(409, ErrorCode.INVALID_STATE, 'A solo portfolio can only have one member');
  }
  const data: Prisma.PortfolioUpdateInput = {};
  if (b.name) data.name = b.name;
  if (b.type) data.type = b.type;
  if (b.contributionAmount !== undefined) data.contributionAmount = new Dec(b.contributionAmount);
  if (b.dueDay !== undefined) data.dueDay = b.dueDay;
  if (b.graceDays !== undefined) data.graceDays = b.graceDays;
  if (b.lateFee !== undefined) data.lateFee = new Dec(b.lateFee);
  if (b.startMonth) data.startMonth = b.startMonth;
  if (b.membersSeeTracker !== undefined) data.membersSeeTracker = b.membersSeeTracker;
  if (b.membersSeeShares !== undefined) data.membersSeeShares = b.membersSeeShares;
  if (b.paymentDetails) data.paymentDetails = { ...paymentDetails(ctx.portfolio), ...b.paymentDetails };
  const updated = await prisma.portfolio.update({ where: { id: ctx.portfolio.id }, data });
  await audit(req, { portfolioId: ctx.portfolio.id, action: 'portfolio.settings', entityType: 'portfolio', entityId: ctx.portfolio.id, summary: `Changed settings: ${Object.keys(b).join(', ')}`, data: { changes: JSON.parse(JSON.stringify(b)) } });
  res.json({ data: { ...portfolioInfo(updated), paymentDetails: paymentDetails(updated) } });
});

// --- audit log -----------------------------------------------------------------

adminRouter.get('/audit', adminOnly, async (req, res) => {
  const ctx = pctx(req);
  const q = z.object({ before: z.string().regex(/^\d+$/).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), action: z.string().max(60).optional() }).parse(req.query);
  const rows = await prisma.auditLog.findMany({
    where: { portfolioId: ctx.portfolio.id, ...(q.before ? { id: { lt: BigInt(q.before) } } : {}), ...(q.action ? { action: { startsWith: q.action } } : {}) },
    orderBy: { id: 'desc' },
    take: q.limit + 1,
  });
  const page = rows.slice(0, q.limit);
  res.json({ data: page.map(serializeAudit), meta: { hasMore: rows.length > q.limit, nextBefore: rows.length > q.limit ? page[page.length - 1]!.id.toString() : null } });
});
