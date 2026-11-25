import type { Request, RequestHandler } from 'express';
import type { MemberRole, Membership, Portfolio } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../config/prisma.js';
import { AppError, ErrorCode } from '../../common/errors/app-error.js';
import { auth } from '../auth/auth.middleware.js';
import { adminSessionActive } from '../auth/session.js';

/**
 * Roles, from most to least access:
 * - ADMIN: everything in the admin portal.
 * - LEADER: sees the admin portal; reviews deposits, records cash deposits,
 *   sends reminders and updates prices. Cannot manage members, record
 *   transactions, touch cash, decide exits or change settings.
 * - MEMBER: the member area only.
 *
 * A platform admin with an active admin session can read any portfolio (as if
 * ADMIN) but never change it: the support "view as admin" mode.
 */
export interface PortfolioContext {
  portfolio: Portfolio;
  membership: Membership | null;
  role: MemberRole;
  readOnly: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      portfolioCtx?: PortfolioContext;
    }
  }
}

const RANK: Record<MemberRole, number> = { MEMBER: 0, LEADER: 1, ADMIN: 2 };
const SAFE = new Set(['GET', 'HEAD']);

const idParam = z.coerce.number().int().positive();

export function portfolioAccess(minRole: MemberRole): RequestHandler {
  return async (req, _res, next) => {
    const { user, session } = auth(req);
    const portfolioId = idParam.parse(req.params.portfolioId);
    const portfolio = await prisma.portfolio.findUnique({ where: { id: portfolioId } });
    if (!portfolio) return next(AppError.notFound(ErrorCode.NOT_FOUND, 'Portfolio not found'));

    const membership = await prisma.membership.findUnique({ where: { portfolioId_userId: { portfolioId, userId: user.id } } });
    const active = membership?.status === 'ACTIVE' ? membership : null;

    let ctx: PortfolioContext | null = null;
    if (active && RANK[active.role] >= RANK[minRole]) {
      ctx = { portfolio, membership: active, role: active.role, readOnly: false };
    } else if (user.platformRole === 'PLATFORM_ADMIN' && adminSessionActive(session)) {
      ctx = { portfolio, membership: active, role: 'ADMIN', readOnly: true };
    }
    if (!ctx) {
      // Don't reveal whether a portfolio the user can't see exists.
      return next(active ? new AppError(403, ErrorCode.FORBIDDEN, `This needs the ${minRole.toLowerCase()} role`) : AppError.notFound(ErrorCode.NOT_FOUND, 'Portfolio not found'));
    }
    if (!SAFE.has(req.method)) {
      if (ctx.readOnly) return next(new AppError(403, ErrorCode.READ_ONLY, 'Support view is read-only'));
      if (portfolio.status === 'SUSPENDED') return next(new AppError(403, ErrorCode.PORTFOLIO_SUSPENDED, 'This portfolio is suspended'));
    }
    req.portfolioCtx = ctx;
    next();
  };
}

export function pctx(req: Request): PortfolioContext {
  if (!req.portfolioCtx) throw new Error('portfolioAccess middleware missing');
  return req.portfolioCtx;
}

/** The caller's own active membership; platform viewers without one are refused. */
export function ownMembership(req: Request): Membership {
  const m = pctx(req).membership;
  if (!m) throw new AppError(403, ErrorCode.FORBIDDEN, 'Only members of this portfolio can do this');
  return m;
}

export const idOf = (value: unknown) => idParam.parse(value);
