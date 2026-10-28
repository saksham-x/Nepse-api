import { existsSync } from 'node:fs';
import { z } from 'zod';

// Load ./.env if present. Variables already set in the environment take precedence.
if (process.env.NODE_ENV !== 'test' && existsSync('.env')) process.loadEnvFile('.env');

const bool = z
  .enum(['true', 'false', '1', '0'])
  .default('false')
  .transform((v) => v === 'true' || v === '1');

const csv = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );

const int = (def: number, min = 0) => z.coerce.number().int().min(min).default(def);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: int(3000, 1),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: int(0),

  DATABASE_URL: z.string().startsWith('mysql://', 'DATABASE_URL must be a mysql:// connection string'),

  CORS_ORIGINS: csv,
  JSON_BODY_LIMIT: z.string().default('100kb'),
  API_RATE_LIMIT_WINDOW_MS: int(60_000, 1000),
  API_RATE_LIMIT_MAX: int(300, 1),

  NEPSE_BASE_URL: z.url().default('https://nepalstock.com.np'),
  PROVIDER_TIMEOUT_MS: int(15_000, 1000),
  PROVIDER_MAX_RETRIES: int(3),
  PROVIDER_RETRY_BASE_MS: int(1000, 1),
  PROVIDER_MAX_RETRY_DELAY_MS: int(30_000, 1),
  PROVIDER_MIN_INTERVAL_MS: int(300),
  PROVIDER_SESSION_TTL_MS: int(60_000, 1000),

  SYNC_CONCURRENCY: int(3, 1).pipe(z.number().max(10)),
  SYNC_BATCH_SIZE: int(50, 1).pipe(z.number().max(500)),
  SYNC_SYMBOLS: csv.transform((list) => list.map((s) => s.toUpperCase())),
  SYNC_MAX_CONSECUTIVE_FAILURES: int(10, 1),
  SYNC_INTERVAL_MINUTES: int(0),
  INGESTION_LOCK_TTL_SECONDS: int(1800, 60),

  QUOTE_MAX_AGE_SECONDS: int(300, 1),
  QUOTE_ON_DEMAND_REFRESH: bool,
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    // Only variable names and messages are printed, never values (they may be secrets).
    const problems = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return result.data;
}

export const env = loadEnv();
