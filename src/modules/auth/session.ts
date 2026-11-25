import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Session, User } from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma } from '../../config/prisma.js';

export const SESSION_COOKIE = 'nepse_sid';
/** lastSeenAt is refreshed at most this often, to avoid a write per request. */
const TOUCH_INTERVAL_MS = 5 * 60_000;

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export interface AuthContext {
  user: User;
  session: Session;
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

const cookieOptions = () => ({
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: env.NODE_ENV === 'production',
  path: '/',
});

export async function createSession(req: Request, res: Response, userId: number): Promise<Session> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_DAYS * 86_400_000);
  const session = await prisma.session.create({
    data: { id: hashToken(token), userId, expiresAt, userAgent: req.headers['user-agent']?.slice(0, 255) ?? null },
  });
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions(), expires: expiresAt });
  return session;
}

/** Resolves the session cookie to an active user, or null. Expired sessions are deleted. */
export async function resolveSession(req: Request): Promise<AuthContext | null> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const session = await prisma.session.findUnique({ where: { id: hashToken(token) }, include: { user: true } });
  if (!session) return null;
  if (session.expiresAt <= new Date() || session.user.status !== 'ACTIVE') {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }
  if (Date.now() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
  }
  const { user, ...rest } = session;
  return { user, session: rest };
}

export async function destroySession(req: Request, res: Response): Promise<void> {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) await prisma.session.deleteMany({ where: { id: hashToken(token) } });
  res.clearCookie(SESSION_COOKIE, cookieOptions());
}

export const adminSessionActive = (session: Session) => !!session.adminUntil && session.adminUntil > new Date();
