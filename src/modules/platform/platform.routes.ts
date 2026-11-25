import { Router } from 'express';
import { z } from 'zod';
import { logger } from '../../config/logger.js';
import { prisma } from '../../config/prisma.js';
import { AppError, ErrorCode } from '../../common/errors/app-error.js';
import { decimalToNumber } from '../../common/utils/serialize.js';
import { isValidTradeDate, tradeDateFromDb, tradeDateToDb } from '../../common/utils/time.js';
import { audit, serializeAudit } from '../audit/audit.js';
import { auth, requireAuth, requirePlatformAdmin } from '../auth/auth.middleware.js';
import { getIngestionService, IngestionLockedError } from '../ingestion/ingestion.service.js';
import { symbolSchema } from '../instruments/instruments.validation.js';
import { Dec } from '../portfolios/ledger.js';
import { idOf } from '../portfolios/portfolio.access.js';
import { computeState, num } from '../portfolios/portfolio.service.js';

export const platformRouter = Router();
platformRouter.use(requireAuth, requirePlatformAdmin);

const search = z.object({ search: z.string().trim().max(100).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) });

// --- usage stats ---------------------------------------------------------------

platformRouter.get('/stats', async (_req, res) => {
  const [users, suspendedUsers, portfolios, byType, activeMemberships, pendingDeposits, openReports, lastSync] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { status: 'SUSPENDED' } }),
    prisma.portfolio.count(),
    prisma.portfolio.groupBy({ by: ['type'], _count: { _all: true } }),
    prisma.membership.count({ where: { status: 'ACTIVE' } }),
    prisma.deposit.count({ where: { status: 'PENDING' } }),
    prisma.abuseReport.count({ where: { status: 'OPEN' } }),
    prisma.ingestionRun.findFirst({ where: { type: 'SYNC' }, orderBy: { startedAt: 'desc' } }),
  ]);
  // AUM: each portfolio's latest snapshot (written whenever anyone views or changes it).
  const latest = await prisma.$queryRaw<{ total: string | null }[]>`
    SELECT SUM(s.total_value) AS total FROM nav_snapshots s
    JOIN (SELECT portfolio_id, MAX(date) AS d FROM nav_snapshots GROUP BY portfolio_id) m
      ON m.portfolio_id = s.portfolio_id AND m.d = s.date`;
  const newUsers30d = await prisma.user.count({ where: { createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } } });
  res.json({
    data: {
      users,
      suspendedUsers,
      newUsers30d,
      portfolios,
      portfoliosByType: Object.fromEntries(byType.map((b) => [b.type, b._count._all])),
      activeMemberships,
      aum: Number(latest[0]?.total ?? 0),
      pendingDeposits,
      openReports,
      lastSync: lastSync ? { status: lastSync.status, startedAt: lastSync.startedAt.toISOString(), finishedAt: lastSync.finishedAt?.toISOString() ?? null } : null,
    },
  });
});

// --- users ---------------------------------------------------------------------

platformRouter.get('/users', async (req, res) => {
  const q = search.parse(req.query);
  const rows = await prisma.user.findMany({
    where: q.search ? { OR: [{ email: { contains: q.search } }, { name: { contains: q.search } }] } : {},
    orderBy: { createdAt: 'desc' },
    take: q.limit,
    include: { _count: { select: { memberships: { where: { status: 'ACTIVE' } } } } },
  });
  res.json({
    data: rows.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      platformRole: u.platformRole,
      status: u.status,
      portfolios: u._count.memberships,
      lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
      createdAt: u.createdAt.toISOString(),
    })),
  });
});

platformRouter.patch('/users/:userId', async (req, res) => {
  const me = auth(req).user;
  const id = idOf(req.params.userId);
  const body = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']).optional(), platformRole: z.enum(['USER', 'PLATFORM_ADMIN']).optional() }).parse(req.body);
  if (id === me.id) throw new AppError(409, ErrorCode.INVALID_STATE, "You can't change your own account here");
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw AppError.notFound(ErrorCode.NOT_FOUND, 'User not found');
  await prisma.$transaction([
    prisma.user.update({ where: { id }, data: body }),
    // Suspending signs the user out everywhere.
    ...(body.status === 'SUSPENDED' ? [prisma.session.deleteMany({ where: { userId: id } })] : []),
  ]);
  await audit(req, { action: 'platform.user_update', entityType: 'user', entityId: id, summary: `Updated ${user.email}: ${JSON.stringify(body)}` });
  res.status(204).end();
});

/** Deleting a user is refused while they administer a portfolio or hold units; suspend them instead. */
platformRouter.delete('/users/:userId', async (req, res) => {
  const id = idOf(req.params.userId);
  if (id === auth(req).user.id) throw new AppError(409, ErrorCode.INVALID_STATE, "You can't delete your own account");
  const user = await prisma.user.findUnique({ where: { id }, include: { memberships: { where: { status: 'ACTIVE' } } } });
  if (!user) throw AppError.notFound(ErrorCode.NOT_FOUND, 'User not found');
  if (user.memberships.length > 0) {
    throw new AppError(409, ErrorCode.INVALID_STATE, `${user.email} is still in ${user.memberships.length} portfolio(s). Exit or remove them first, or suspend the account.`);
  }
  const anyUnits = await prisma.unitEntry.count({ where: { membership: { userId: id } } });
  if (anyUnits > 0) {
    // Their deposit and unit history belongs to the portfolios' books, so keep the row and anonymize it.
    await prisma.$transaction([
      prisma.user.update({ where: { id }, data: { email: `deleted-${id}@deleted.invalid`, name: 'Deleted user', phone: null, status: 'SUSPENDED', passwordHash: '!' } }),
      prisma.session.deleteMany({ where: { userId: id } }),
    ]);
  } else {
    await prisma.user.delete({ where: { id } });
  }
  await audit(req, { action: 'platform.user_delete', entityType: 'user', entityId: id, summary: `Deleted ${user.email}${anyUnits ? ' (anonymized, history kept)' : ''}` });
  res.status(204).end();
});

// --- portfolios ----------------------------------------------------------------

platformRouter.get('/portfolios', async (req, res) => {
  const q = search.parse(req.query);
  const rows = await prisma.portfolio.findMany({
    where: q.search ? { name: { contains: q.search } } : {},
    orderBy: { createdAt: 'desc' },
    take: q.limit,
    include: {
      _count: { select: { memberships: { where: { status: 'ACTIVE' } } } },
      memberships: { where: { role: 'ADMIN', status: 'ACTIVE' }, include: { user: { select: { name: true, email: true } } } },
      navSnapshots: { orderBy: { date: 'desc' }, take: 1 },
    },
  });
  res.json({
    data: rows.map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      status: p.status,
      members: p._count.memberships,
      admins: p.memberships.map((m) => ({ name: m.user.name, email: m.user.email })),
      value: p.navSnapshots[0] ? num(p.navSnapshots[0].totalValue) : 0,
      valueAsOf: p.navSnapshots[0]?.date.toISOString().slice(0, 10) ?? null,
      createdAt: p.createdAt.toISOString(),
    })),
  });
});

platformRouter.patch('/portfolios/:portfolioId', async (req, res) => {
  const id = idOf(req.params.portfolioId);
  const { status } = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']) }).parse(req.body);
  const p = await prisma.portfolio.findUnique({ where: { id } });
  if (!p) throw AppError.notFound(ErrorCode.NOT_FOUND, 'Portfolio not found');
  await prisma.portfolio.update({ where: { id }, data: { status } });
  await audit(req, { portfolioId: id, action: 'platform.portfolio_status', entityType: 'portfolio', entityId: id, summary: `Set "${p.name}" to ${status.toLowerCase()}` });
  res.status(204).end();
});

/** Permanently deletes a portfolio and its books. The audit log entries remain. */
platformRouter.delete('/portfolios/:portfolioId', async (req, res) => {
  const id = idOf(req.params.portfolioId);
  const { confirmName } = z.object({ confirmName: z.string() }).parse(req.body ?? {});
  const p = await prisma.portfolio.findUnique({ where: { id } });
  if (!p) throw AppError.notFound(ErrorCode.NOT_FOUND, 'Portfolio not found');
  if (confirmName !== p.name) throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Type the portfolio name exactly to confirm');
  const value = (await computeState(id)).totalValue;
  await prisma.$transaction(async (db) => {
    // Holdings are protected by their transactions (onDelete: Restrict), so remove transactions first.
    await db.portfolioTransaction.deleteMany({ where: { portfolioId: id } });
    await db.portfolio.delete({ where: { id } });
  });
  await audit(req, { portfolioId: id, action: 'platform.portfolio_delete', entityType: 'portfolio', entityId: id, summary: `Deleted portfolio "${p.name}" (value at deletion Rs ${value.toFixed(2)})` });
  res.status(204).end();
});

// --- NEPSE price sync ----------------------------------------------------------

let backgroundSync: Promise<unknown> | null = null;

platformRouter.get('/sync', async (_req, res) => {
  const runs = await prisma.ingestionRun.findMany({ orderBy: { startedAt: 'desc' }, take: 20 });
  res.json({
    data: {
      running: backgroundSync !== null || runs.some((r) => r.status === 'RUNNING'),
      runs: runs.map((r) => ({
        id: r.id,
        type: r.type,
        status: r.status,
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
        requested: r.requested,
        processed: r.processed,
        inserted: r.inserted,
        updated: r.updated,
        unchanged: r.unchanged,
        skipped: r.skipped,
        failed: r.failed,
        errorMessage: r.errorMessage,
      })),
    },
  });
});

/** Starts a sync in the background; progress shows up in GET /sync. */
platformRouter.post('/sync', async (req, res) => {
  const { symbols, force } = z.object({ symbols: z.array(symbolSchema).max(600).optional(), force: z.boolean().default(false) }).parse(req.body ?? {});
  if (backgroundSync) throw new AppError(409, ErrorCode.INVALID_STATE, 'A sync started from here is still running');
  backgroundSync = getIngestionService()
    .runSync({ symbols, force })
    .catch((err) => {
      if (!(err instanceof IngestionLockedError)) logger.error({ err }, 'platform-triggered sync failed');
    })
    .finally(() => {
      backgroundSync = null;
    });
  await audit(req, { action: 'platform.sync_start', summary: `Started a NEPSE sync${symbols?.length ? ` for ${symbols.join(', ')}` : ' for all instruments'}${force ? ' (forced)' : ''}` });
  res.status(202).json({ data: { started: true } });
});

platformRouter.get('/prices/:symbol', async (req, res) => {
  const symbol = symbolSchema.parse(req.params.symbol);
  const instrument = await prisma.instrument.findUnique({ where: { symbol }, include: { quote: true } });
  if (!instrument) throw AppError.notFound(ErrorCode.INSTRUMENT_NOT_FOUND, `Unknown symbol '${symbol}'`);
  const candles = await prisma.dailyCandle.findMany({ where: { instrumentId: instrument.id }, orderBy: { tradeDate: 'desc' }, take: 30 });
  res.json({
    data: {
      symbol,
      name: instrument.name,
      quote: instrument.quote
        ? { lastTradedPrice: decimalToNumber(instrument.quote.lastTradedPrice), previousClose: decimalToNumber(instrument.quote.previousClose), businessDate: tradeDateFromDb(instrument.quote.businessDate), fetchedAt: instrument.quote.fetchedAt.toISOString() }
        : null,
      candles: candles.map((c) => ({
        date: tradeDateFromDb(c.tradeDate),
        open: decimalToNumber(c.open),
        high: decimalToNumber(c.high),
        low: decimalToNumber(c.low),
        close: decimalToNumber(c.close),
        volume: Number(c.volume),
        provisional: c.isProvisional,
        source: c.source,
      })),
    },
  });
});

const ohlcBody = z
  .object({ open: z.number().positive(), high: z.number().positive(), low: z.number().positive(), close: z.number().positive(), volume: z.number().int().min(0).optional() })
  .refine((c) => c.low <= Math.min(c.open, c.close) && c.high >= Math.max(c.open, c.close), 'Need low ≤ open, close ≤ high');

/** Fixes a bad daily candle. It becomes a manual correction (source CSV_IMPORT, final). */
platformRouter.patch('/prices/:symbol/candles/:date', async (req, res) => {
  const symbol = symbolSchema.parse(req.params.symbol);
  const day = z.string().refine(isValidTradeDate, 'date must be YYYY-MM-DD').parse(req.params.date);
  const body = ohlcBody.parse(req.body);
  const instrument = await prisma.instrument.findUnique({ where: { symbol } });
  if (!instrument) throw AppError.notFound(ErrorCode.INSTRUMENT_NOT_FOUND, `Unknown symbol '${symbol}'`);
  const before = await prisma.dailyCandle.findUnique({ where: { instrumentId_tradeDate: { instrumentId: instrument.id, tradeDate: tradeDateToDb(day) } } });
  if (!before) throw AppError.notFound(ErrorCode.NOT_FOUND, `No candle for ${symbol} on ${day}`);
  await prisma.dailyCandle.update({
    where: { id: before.id },
    data: { open: new Dec(body.open), high: new Dec(body.high), low: new Dec(body.low), close: new Dec(body.close), ...(body.volume !== undefined ? { volume: BigInt(body.volume) } : {}), isProvisional: false, source: 'CSV_IMPORT' },
  });
  await audit(req, {
    action: 'platform.price_fix',
    entityType: 'candle',
    entityId: `${symbol}:${day}`,
    summary: `Corrected ${symbol} ${day}: close ${before.close.toFixed(2)} → ${body.close.toFixed(2)}`,
    data: { before: { open: before.open.toString(), high: before.high.toString(), low: before.low.toString(), close: before.close.toString() }, after: body },
  });
  res.status(204).end();
});

/** Fixes the stored latest price (what portfolios use for NEPSE-priced holdings). */
platformRouter.patch('/prices/:symbol/quote', async (req, res) => {
  const symbol = symbolSchema.parse(req.params.symbol);
  const { lastTradedPrice } = z.object({ lastTradedPrice: z.number().positive() }).parse(req.body);
  const instrument = await prisma.instrument.findUnique({ where: { symbol }, include: { quote: true } });
  if (!instrument?.quote) throw AppError.notFound(ErrorCode.QUOTE_NOT_AVAILABLE, `No stored quote for ${symbol}`);
  await prisma.quote.update({ where: { instrumentId: instrument.id }, data: { lastTradedPrice: new Dec(lastTradedPrice), fetchedAt: new Date() } });
  await audit(req, { action: 'platform.quote_fix', entityType: 'quote', entityId: symbol, summary: `Corrected ${symbol} last price ${instrument.quote.lastTradedPrice.toFixed(2)} → ${lastTradedPrice.toFixed(2)}` });
  res.status(204).end();
});

// --- abuse reports -------------------------------------------------------------

platformRouter.get('/reports', async (req, res) => {
  const { status } = z.object({ status: z.enum(['OPEN', 'RESOLVED', 'DISMISSED']).optional() }).parse(req.query);
  const rows = await prisma.abuseReport.findMany({ where: status ? { status } : {}, orderBy: { createdAt: 'desc' }, take: 200 });
  const userIds = [...new Set(rows.flatMap((r) => [r.reporterId, r.reportedUserId]).filter((v): v is number => v !== null))];
  const portfolioIds = [...new Set(rows.map((r) => r.portfolioId).filter((v): v is number => v !== null))];
  const [users, portfolios] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }),
    prisma.portfolio.findMany({ where: { id: { in: portfolioIds } }, select: { id: true, name: true } }),
  ]);
  const u = new Map(users.map((x) => [x.id, x]));
  const p = new Map(portfolios.map((x) => [x.id, x]));
  res.json({
    data: rows.map((r) => ({
      id: r.id,
      reason: r.reason,
      details: r.details,
      status: r.status,
      resolutionNote: r.resolutionNote,
      reporter: u.get(r.reporterId) ?? null,
      reportedUser: r.reportedUserId ? (u.get(r.reportedUserId) ?? null) : null,
      portfolio: r.portfolioId ? (p.get(r.portfolioId) ?? { id: r.portfolioId, name: '(deleted)' }) : null,
      createdAt: r.createdAt.toISOString(),
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
    })),
  });
});

platformRouter.patch('/reports/:reportId', async (req, res) => {
  const id = idOf(req.params.reportId);
  const body = z.object({ status: z.enum(['OPEN', 'RESOLVED', 'DISMISSED']), resolutionNote: z.string().trim().max(500).optional() }).parse(req.body);
  const report = await prisma.abuseReport.findUnique({ where: { id } });
  if (!report) throw AppError.notFound(ErrorCode.NOT_FOUND, 'Report not found');
  await prisma.abuseReport.update({
    where: { id },
    data: { status: body.status, resolutionNote: body.resolutionNote ?? null, resolvedById: body.status === 'OPEN' ? null : auth(req).user.id, resolvedAt: body.status === 'OPEN' ? null : new Date() },
  });
  await audit(req, { portfolioId: report.portfolioId, action: 'platform.report', entityType: 'report', entityId: id, summary: `Marked report #${id} ${body.status.toLowerCase()}${body.resolutionNote ? `: ${body.resolutionNote}` : ''}` });
  res.status(204).end();
});

// --- global audit log ----------------------------------------------------------

platformRouter.get('/audit', async (req, res) => {
  const q = z.object({ before: z.string().regex(/^\d+$/).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), portfolioId: z.coerce.number().int().optional(), action: z.string().max(60).optional() }).parse(req.query);
  const rows = await prisma.auditLog.findMany({
    where: { ...(q.before ? { id: { lt: BigInt(q.before) } } : {}), ...(q.portfolioId ? { portfolioId: q.portfolioId } : {}), ...(q.action ? { action: { startsWith: q.action } } : {}) },
    orderBy: { id: 'desc' },
    take: q.limit + 1,
  });
  const page = rows.slice(0, q.limit);
  res.json({ data: page.map(serializeAudit), meta: { hasMore: rows.length > q.limit, nextBefore: rows.length > q.limit ? page[page.length - 1]!.id.toString() : null } });
});
