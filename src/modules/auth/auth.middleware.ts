import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { env } from '../../config/env.js';
import { AppError, ErrorCode } from '../../common/errors/app-error.js';
import { adminSessionActive, resolveSession, type AuthContext } from './session.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const LOCALHOST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * CSRF defence for cookie-authenticated writes, on top of SameSite=Lax: a
 * browser request that changes state must come from an allowed origin.
 * Requests without an Origin header (curl, server-to-server) carry no cookie
 * from a victim's browser and are let through.
 */
export function checkOrigin(req: Request, _res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (SAFE_METHODS.has(req.method) || !origin || env.CORS_ORIGINS.includes('*') || env.CORS_ORIGINS.includes(origin)) return next();
  if (env.NODE_ENV !== 'production' && LOCALHOST_ORIGIN.test(origin)) return next();
  next(new AppError(403, ErrorCode.FORBIDDEN, 'Request origin is not allowed'));
}

export function auth(req: Request): AuthContext {
  if (!req.auth) throw new AppError(401, ErrorCode.UNAUTHENTICATED, 'Please log in');
  return req.auth;
}

export const requireAuth: RequestHandler = async (req, _res, next) => {
  const ctx = await resolveSession(req);
  if (!ctx) return next(new AppError(401, ErrorCode.UNAUTHENTICATED, 'Please log in'));
  req.auth = ctx;
  next();
};

/** Platform admin routes: the role, plus a recent "Sign in as admin" on this session. */
export const requirePlatformAdmin: RequestHandler = (req, _res, next) => {
  const { user, session } = auth(req);
  if (user.platformRole !== 'PLATFORM_ADMIN') return next(new AppError(403, ErrorCode.FORBIDDEN, 'Platform admins only'));
  if (!adminSessionActive(session)) return next(new AppError(403, ErrorCode.ADMIN_SESSION_REQUIRED, 'Sign in as admin to continue'));
  next();
};
