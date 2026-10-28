import { logger } from '../config/logger.js';
import { prisma } from '../config/prisma.js';
import { IngestionLockedError, type IngestionSummary } from '../modules/ingestion/ingestion.service.js';

/** Exit codes: 0 succeeded, 1 failed, 2 partially succeeded, 3 another run holds the lock. */
export async function runJob(name: string, job: (signal: AbortSignal) => Promise<IngestionSummary | void>): Promise<void> {
  const controller = new AbortController();
  const onSignal = () => {
    logger.warn({ job: name }, 'stop requested; finishing in-flight work');
    controller.abort();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  let exitCode = 0;
  try {
    const summary = await job(controller.signal);
    if (summary) {
      const { skipped, failures, ...rest } = summary;
      logger.info({ job: name, ...rest, skippedSample: skipped.slice(0, 20), failuresSample: failures.slice(0, 20) }, `${name} complete`);
      exitCode = summary.status === 'SUCCEEDED' ? 0 : summary.status === 'PARTIAL' ? 2 : 1;
    }
  } catch (err) {
    if (err instanceof IngestionLockedError) {
      logger.warn({ job: name }, err.message);
      exitCode = 3;
    } else {
      logger.error({ err, job: name }, `${name} failed`);
      exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
  process.exitCode = exitCode;
}

export function parseSymbols(value: string | undefined): string[] | undefined {
  const list = value?.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  return list?.length ? list : undefined;
}
