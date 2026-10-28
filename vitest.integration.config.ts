import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

if (!process.env.TEST_DATABASE_URL && existsSync('.env')) process.loadEnvFile('.env');

/** MySQL-backed repository tests. Requires TEST_DATABASE_URL pointing at a database whose name ends in _test. */
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.mysql.test.ts'],
    environment: 'node',
    globalSetup: ['tests/integration/mysql.global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',
    },
  },
});
