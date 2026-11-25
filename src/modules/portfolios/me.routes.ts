import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/prisma.js';
import { AppError, ErrorCode } from '../../common/errors/app-error.js';
import { kathmanduDate } from '../../common/utils/time.js';
import { audit } from '../audit/audit.js';
import { auth, requireAuth } from '../auth/auth.middleware.js';
import { Dec } from './ledger.js';
import { contributionTracker } from './portfolio.operations.js';
import { capitalByMembership, currentState, groupTotals, memberNumbers } from './portfolio.service.js';
import { idOf } from './portfolio.access.js';

export const meRouter = Router();
meRouter.use(requireAuth);

const serializeNotification = (n: { id: number; type: string; portfolioId: number | null; title: string; body: string | null; link: string | null; readAt: Date | null; createdAt: Date }) => ({
  id: n.id,
  type: n.type,
  portfolioId: n.portfolioId,
  title: n.title,
  body: n.body,
  link: n.link,
  read: n.readAt !== null,
  createdAt: n.createdAt.toISOString(),
});

/** Member home: one card per portfolio, net worth, and alerts. */
meRouter.get('/home', async (req, res) => {
  const { user } = auth(req);
  const memberships = await prisma.membership.findMany({ where: { userId: user.id, status: 'ACTIVE' }, include: { portfolio: true }, orderBy: { joinedAt: 'asc' } });

  const cards = [];
  const dueAlerts = [];
  let netWorth = 0;
  for (const m of memberships) {
    const state = await currentState(m.portfolioId);
    const capital = await capitalByMembership(m.portfolioId);
    const mine = memberNumbers(state, m.id, capital.contributed.get(m.id) ?? new Dec(0), capital.paidOut.get(m.id));
    const totals = groupTotals(state);
    netWorth += mine.currentValue;
    cards.push({
      portfolioId: m.portfolioId,
      name: m.portfolio.name,
      type: m.portfolio.type,
      status: m.portfolio.status,
      role: m.role,
      group: { currentValue: totals.currentValue, profit: totals.profit, profitPercent: totals.profitPercent, navPerUnit: totals.navPerUnit },
      mine,
    });
    const tracker = await contributionTracker(m.portfolio, { membershipIds: [m.id] });
    for (const cell of tracker.rows[0]?.cells ?? []) {
      if (cell.outstanding > 0 && cell.status !== 'PENDING') {
        dueAlerts.push({ portfolioId: m.portfolioId, portfolioName: m.portfolio.name, period: cell.period, dueDate: cell.dueDate, amount: cell.outstanding, late: cell.status === 'LATE' });
      }
    }
  }

  const [notifications, unread, invitations] = await Promise.all([
    prisma.notification.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' }, take: 15 }),
    prisma.notification.count({ where: { userId: user.id, readAt: null } }),
    prisma.invitation.findMany({ where: { email: user.email, status: 'PENDING' }, include: { portfolio: { select: { name: true, type: true } } } }),
  ]);

  res.json({
    data: {
      netWorth: Math.round(netWorth * 100) / 100,
      portfolios: cards,
      paymentsDue: dueAlerts,
      notifications: notifications.map(serializeNotification),
      unreadCount: unread,
      invitations: invitations.map((i) => ({ id: i.id, portfolioId: i.portfolioId, portfolioName: i.portfolio.name, portfolioType: i.portfolio.type, role: i.role, createdAt: i.createdAt.toISOString() })),
    },
  });
});

meRouter.get('/notifications', async (req, res) => {
  const { user } = auth(req);
  const rows = await prisma.notification.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' }, take: 100 });
  res.json({ data: rows.map(serializeNotification) });
});

meRouter.post('/notifications/read', async (req, res) => {
  const { user } = auth(req);
  const { ids } = z.object({ ids: z.array(z.number().int()).max(500).optional() }).parse(req.body ?? {});
  await prisma.notification.updateMany({ where: { userId: user.id, readAt: null, ...(ids ? { id: { in: ids } } : {}) }, data: { readAt: new Date() } });
  res.status(204).end();
});

async function pendingInvitation(email: string, id: number) {
  const inv = await prisma.invitation.findFirst({ where: { id, email, status: 'PENDING' }, include: { portfolio: true } });
  if (!inv) throw AppError.notFound(ErrorCode.NOT_FOUND, 'Invitation not found');
  return inv;
}

meRouter.post('/invitations/:id/accept', async (req, res) => {
  const { user } = auth(req);
  const inv = await pendingInvitation(user.email, idOf(req.params.id));
  if (inv.portfolio.status !== 'ACTIVE') throw new AppError(403, ErrorCode.PORTFOLIO_SUSPENDED, 'This portfolio is suspended');
  await prisma.$transaction(async (db) => {
    const existing = await db.membership.findUnique({ where: { portfolioId_userId: { portfolioId: inv.portfolioId, userId: user.id } } });
    if (existing?.status === 'ACTIVE') throw new AppError(409, ErrorCode.INVALID_STATE, 'You are already a member');
    if (existing) await db.membership.update({ where: { id: existing.id }, data: { status: 'ACTIVE', role: inv.role, joinedAt: new Date(), leftAt: null } });
    else await db.membership.create({ data: { portfolioId: inv.portfolioId, userId: user.id, role: inv.role } });
    await db.invitation.update({ where: { id: inv.id }, data: { status: 'ACCEPTED', respondedAt: new Date() } });
    await audit(req, { portfolioId: inv.portfolioId, action: 'member.join', entityType: 'user', entityId: user.id, summary: `${user.name} joined as ${inv.role.toLowerCase()}` }, db);
  });
  res.status(204).end();
});

meRouter.post('/invitations/:id/decline', async (req, res) => {
  const { user } = auth(req);
  const inv = await pendingInvitation(user.email, idOf(req.params.id));
  await prisma.invitation.update({ where: { id: inv.id }, data: { status: 'DECLINED', respondedAt: new Date() } });
  res.status(204).end();
});

const createPortfolioSchema = z.object({
  name: z.string().trim().min(2).max(120),
  type: z.enum(['GROUP', 'SOLO', 'MANAGED']).default('GROUP'),
  contributionAmount: z.number().min(0).max(1e12).default(0),
  dueDay: z.number().int().min(1).max(28).default(10),
  initialUnitPrice: z.number().positive().max(1e6).default(10),
  startMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
});

/** Anyone signed in can start a portfolio and becomes its admin. */
meRouter.post('/portfolios', async (req, res) => {
  const { user } = auth(req);
  const body = createPortfolioSchema.parse(req.body);
  const portfolio = await prisma.$transaction(async (db) => {
    const p = await db.portfolio.create({
      data: {
        name: body.name,
        type: body.type,
        contributionAmount: new Dec(body.contributionAmount),
        dueDay: body.dueDay,
        initialUnitPrice: new Dec(body.initialUnitPrice),
        startMonth: body.startMonth ?? kathmanduDate().slice(0, 7),
        createdById: user.id,
      },
    });
    await db.membership.create({ data: { portfolioId: p.id, userId: user.id, role: 'ADMIN' } });
    await audit(req, { portfolioId: p.id, action: 'portfolio.create', entityType: 'portfolio', entityId: p.id, summary: `${user.name} created ${p.type.toLowerCase()} portfolio "${p.name}"` }, db);
    return p;
  });
  res.status(201).json({ data: { id: portfolio.id, name: portfolio.name, type: portfolio.type } });
});

/** Report abuse to the platform admins, optionally about a portfolio or a user. */
meRouter.post('/reports', async (req, res) => {
  const { user } = auth(req);
  const body = z
    .object({
      reason: z.string().trim().min(3).max(120),
      details: z.string().trim().max(5000).optional(),
      portfolioId: z.number().int().positive().optional(),
      reportedUserId: z.number().int().positive().optional(),
    })
    .parse(req.body);
  const report = await prisma.abuseReport.create({
    data: { reporterId: user.id, reason: body.reason, details: body.details ?? null, portfolioId: body.portfolioId ?? null, reportedUserId: body.reportedUserId ?? null },
  });
  res.status(201).json({ data: { id: report.id } });
});
