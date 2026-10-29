import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/api.test.ts', 'tests/integration/realtime.test.ts'],
    environment: 'node',
    restoreMocks: true,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      // Never connected to: unit and API tests mock every repository.
      DATABASE_URL: 'mysql://unit:unit@127.0.0.1:1/unit_tests_do_not_connect',
      CORS_ORIGINS: 'http://localhost:5173',
    },
  },
});
