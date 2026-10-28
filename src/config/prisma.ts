import { PrismaClient } from '@prisma/client';
import { env } from './env.js';

export const prisma = new PrismaClient({
  datasourceUrl: env.DATABASE_URL,
  // Outside development, errors are logged as structured JSON by the error
  // handler and ingestion code instead of Prisma's multi-line stderr output.
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : [],
});
