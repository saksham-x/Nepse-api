import { Router } from 'express';
import { prisma } from '../config/prisma.js';
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
