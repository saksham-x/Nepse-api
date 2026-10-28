import type { Server } from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { prisma } from './config/prisma.js';
import { getIngestionService, IngestionLockedError } from './modules/ingestion/ingestion.service.js';

const SHUTDOWN_TIMEOUT_MS = 15_000;

const server: Server = createApp().listen(env.PORT, env.HOST, () => {
  logger.info({ host: env.HOST, port: env.PORT, env: env.NODE_ENV }, 'nepse-api listening');
});

// ---------------------------------------------------------------------------
// Optional in-process scheduler (single-instance deployments only; see README).
// ---------------------------------------------------------------------------
const shutdownController = new AbortController();
let schedulerTimer: NodeJS.Timeout | undefined;
let runningSync: Promise<unknown> | undefined;

function scheduleNextSync(): void {
  if (env.SYNC_INTERVAL_MINUTES === 0 || shutdownController.signal.aborted) return;
  schedulerTimer = setTimeout(() => {
    runningSync = getIngestionService()
      .runSync({ signal: shutdownController.signal })
      .catch((err) => {
        if (err instanceof IngestionLockedError) logger.info('scheduled sync skipped: another run holds the lock');
        else logger.error({ err }, 'scheduled sync failed');
      })
      .finally(() => {
        runningSync = undefined;
        scheduleNextSync();
      });
  }, env.SYNC_INTERVAL_MINUTES * 60_000);
}

if (env.SYNC_INTERVAL_MINUTES > 0) {
  logger.info({ everyMinutes: env.SYNC_INTERVAL_MINUTES }, 'in-process sync scheduler enabled');
  scheduleNextSync();
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');

  const force = setTimeout(() => {
    logger.error('shutdown timed out; exiting');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  force.unref();

  shutdownController.abort();
  clearTimeout(schedulerTimer);
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();
  await closed;
  // Let an in-progress sync stop at its next item and record its final status.
  await runningSync;
  await prisma.$disconnect();
  logger.info('shutdown complete');
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandled promise rejection');
});
