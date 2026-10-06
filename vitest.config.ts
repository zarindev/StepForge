import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts', 'apps/server/test/**/*.test.ts',
      'apps/cli/test/**/*.test.ts', 'demo/**/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
