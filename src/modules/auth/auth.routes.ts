import { Router, type Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Prisma, Session, User } from '@prisma/client';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { prisma } from '../../config/prisma.js';
import { AppError, ErrorCode } from '../../common/errors/app-error.js';
import { audit } from '../audit/audit.js';
import { readPrefs } from '../notifications/notify.js';
import { auth, requireAuth } from './auth.middleware.js';
import { DUMMY_HASH, hashPassword, verifyPassword } from './password.js';
import { adminSessionActive, createSession, destroySession, resolveSession } from './session.js';

export const authRouter = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: env.AUTH_RATE_LIMIT_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, _res, next) => next(new AppError(429, ErrorCode.RATE_LIMITED, 'Too many attempts, try again in a few minutes')),
});

const email = z.string().trim().toLowerCase().email().max(255);
const password = z.string().min(8, 'Password must be at least 8 characters').max(200);

const registerSchema = z.object({ name: z.string().trim().min(1).max(120), email, password });
const loginSchema = z.object({ email, password: z.string().min(1).max(200) });
const profileSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  language: z.enum(['en', 'ne']).optional(),
  theme: z.enum(['system', 'light', 'dark']).optional(),
  notificationPrefs: z
    .object({ paymentDue: z.boolean(), depositUpdates: z.boolean(), trades: z.boolean(), exits: z.boolean() })
    .partial()
    .optional(),
});
const passwordChangeSchema = z.object({ currentPassword: z.string().min(1).max(200), newPassword: password });

/** Platform admins listed in PLATFORM_ADMIN_EMAILS are promoted when they register or log in. */
async function applyBootstrapRole(user: User): Promise<User> {
  if (user.platformRole === 'PLATFORM_ADMIN' || !env.PLATFORM_ADMIN_EMAILS.includes(user.email)) return user;
  return prisma.user.update({ where: { id: user.id }, data: { platformRole: 'PLATFORM_ADMIN' } });
}

export async function currentUserDto(user: User, session: Session) {
  const memberships = await prisma.membership.findMany({
    where: { userId: user.id, status: 'ACTIVE' },
    include: { portfolio: { select: { id: true, name: true, type: true, status: true } } },
    orderBy: { joinedAt: 'asc' },
  });
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    phone: user.phone,
    platformRole: user.platformRole,
    isPlatformAdmin: user.platformRole === 'PLATFORM_ADMIN',
    adminSessionActive: user.platformRole === 'PLATFORM_ADMIN' && adminSessionActive(session),
    adminUntil: session.adminUntil?.toISOString() ?? null,
    language: user.language,
    theme: user.theme,
    notificationPrefs: readPrefs(user.notificationPrefs),
    memberships: memberships.map((m) => ({
      membershipId: m.id,
      portfolioId: m.portfolio.id,
      portfolioName: m.portfolio.name,
      portfolioType: m.portfolio.type,
      portfolioStatus: m.portfolio.status,
      role: m.role,
    })),
  };
}

async function respondWithMe(req: Request, res: import('express').Response, status = 200) {
  const ctx = await resolveSession(req);
  if (!ctx) throw new AppError(401, ErrorCode.UNAUTHENTICATED, 'Please log in');
  res.status(status).json({ data: await currentUserDto(ctx.user, ctx.session) });
}

authRouter.post('/register', authLimiter, async (req, res) => {
  const body = registerSchema.parse(req.body);
  if (await prisma.user.findUnique({ where: { email: body.email } })) {
    throw new AppError(409, ErrorCode.EMAIL_TAKEN, 'An account with this email already exists');
  }
  let user = await prisma.user.create({ data: { name: body.name, email: body.email, passwordHash: await hashPassword(body.password) } });
  user = await applyBootstrapRole(user);
  req.auth = { user, session: await createSession(req, res, user.id) };
  await audit(req, { action: 'user.register', entityType: 'user', entityId: user.id, summary: `${user.name} created an account` });
  res.status(201).json({ data: await currentUserDto(user, req.auth.session) });
});

authRouter.post('/login', authLimiter, async (req, res) => {
  const body = loginSchema.parse(req.body);
  const found = await prisma.user.findUnique({ where: { email: body.email } });
  const ok = await verifyPassword(body.password, found?.passwordHash ?? DUMMY_HASH);
  if (!found || !ok) throw new AppError(401, ErrorCode.INVALID_CREDENTIALS, 'Email or password is incorrect');
  if (found.status !== 'ACTIVE') throw new AppError(403, ErrorCode.ACCOUNT_SUSPENDED, 'This account is suspended');
  const user = await applyBootstrapRole(await prisma.user.update({ where: { id: found.id }, data: { lastLoginAt: new Date() } }));
  const session = await createSession(req, res, user.id);
  res.json({ data: await currentUserDto(user, session) });
});

authRouter.post('/logout', async (req, res) => {
  await destroySession(req, res);
  res.status(204).end();
});

/** Like GET /me, but answers `null` instead of 401 when signed out, so public pages can ask without an error. */
authRouter.get('/session', async (req, res) => {
  const ctx = await resolveSession(req);
  res.json({ data: ctx ? await currentUserDto(ctx.user, ctx.session) : null });
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const { user, session } = auth(req);
  res.json({ data: await currentUserDto(user, session) });
});

authRouter.patch('/me', requireAuth, async (req, res) => {
  const { user } = auth(req);
  const body = profileSchema.parse(req.body);
  const data: Prisma.UserUpdateInput = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.phone !== undefined) data.phone = body.phone || null;
  if (body.language) data.language = body.language;
  if (body.theme) data.theme = body.theme;
  if (body.notificationPrefs) data.notificationPrefs = { ...readPrefs(user.notificationPrefs), ...body.notificationPrefs };
  await prisma.user.update({ where: { id: user.id }, data });
  await respondWithMe(req, res);
});

authRouter.post('/me/password', requireAuth, authLimiter, async (req, res) => {
  const { user, session } = auth(req);
  const body = passwordChangeSchema.parse(req.body);
  if (!(await verifyPassword(body.currentPassword, user.passwordHash))) {
    throw new AppError(400, ErrorCode.INVALID_CREDENTIALS, 'Current password is incorrect');
  }
  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(body.newPassword) } }),
    // Changing the password signs out every other device.
    prisma.session.deleteMany({ where: { userId: user.id, id: { not: session.id } } }),
  ]);
  await audit(req, { action: 'user.password_change', entityType: 'user', entityId: user.id, summary: `${user.name} changed their password` });
  res.status(204).end();
});

/** "Sign in as admin": platform admins re-enter their password to unlock /platform routes for a while. */
authRouter.post('/admin-session', requireAuth, authLimiter, async (req, res) => {
  const { user, session } = auth(req);
  const { password: pw } = z.object({ password: z.string().min(1).max(200) }).parse(req.body);
  if (user.platformRole !== 'PLATFORM_ADMIN') throw new AppError(403, ErrorCode.FORBIDDEN, 'Platform admins only');
  if (!(await verifyPassword(pw, user.passwordHash))) throw new AppError(401, ErrorCode.INVALID_CREDENTIALS, 'Password is incorrect');
  const adminUntil = new Date(Date.now() + env.ADMIN_SESSION_MINUTES * 60_000);
  await prisma.session.update({ where: { id: session.id }, data: { adminUntil } });
  await audit(req, { action: 'platform.admin_sign_in', entityType: 'user', entityId: user.id, summary: `${user.name} signed in as platform admin` });
  await respondWithMe(req, res);
});

authRouter.delete('/admin-session', requireAuth, async (req, res) => {
  await prisma.session.update({ where: { id: auth(req).session.id }, data: { adminUntil: null } });
  await respondWithMe(req, res);
});
