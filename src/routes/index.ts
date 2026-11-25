import { Router } from 'express';
import { prisma } from '../config/prisma.js';
import { authRouter } from '../modules/auth/auth.routes.js';
import { requireAuth } from '../modules/auth/auth.middleware.js';
import { platformRouter } from '../modules/platform/platform.routes.js';
import { adminRouter } from '../modules/portfolios/admin.routes.js';
import { meRouter } from '../modules/portfolios/me.routes.js';
import { memberRouter } from '../modules/portfolios/member.routes.js';
import { indicatorsRouter } from '../modules/indicators/indicators.routes.js';
import { instrumentsRouter } from '../modules/instruments/instruments.routes.js';
import { lastSuccessfulSyncAt } from '../modules/market-data/market-data.repository.js';
import { marketDataRouter } from '../modules/market-data/market-data.routes.js';

export const apiRouter = Router();

apiRouter.get('/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const lastSync = await lastSuccessfulSyncAt();
    res.json({ data: { status: 'ok', database: 'up', uptimeSeconds: Math.round(process.uptime()), lastSuccessfulSyncAt: lastSync?.toISOString() ?? null } });
  } catch (err) {
    req.log.error({ err }, 'health check: database unreachable');
    res.status(503).json({ data: { status: 'degraded', database: 'down', uptimeSeconds: Math.round(process.uptime()) } });
  }
});

apiRouter.use('/instruments', instrumentsRouter);
apiRouter.use('/market-data', marketDataRouter);
apiRouter.use('/indicators', indicatorsRouter);

// Accounts and portfolios (cookie session). The admin router is mounted first so
// /portfolios/:id/admin/* never reaches the member router's handlers.
apiRouter.use('/auth', authRouter);
apiRouter.use('/me', meRouter);
apiRouter.use('/portfolios/:portfolioId/admin', requireAuth, adminRouter);
apiRouter.use('/portfolios/:portfolioId', requireAuth, memberRouter);
apiRouter.use('/platform', platformRouter);
