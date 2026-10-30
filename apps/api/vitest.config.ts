import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@ff/api',
    // One Postgres container for the whole run; each test file gets its own database.
    globalSetup: ['./test/helpers/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
