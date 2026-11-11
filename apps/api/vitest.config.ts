import { configDefaults, defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@ff/api',
    // test-workers/ runs in workerd through vitest.workers.config.ts.
    exclude: [...configDefaults.exclude, 'test-workers/**'],
    // One Postgres container for the whole run; each test file gets its own database.
    globalSetup: ['./test/helpers/global-setup.ts'],
    testTimeout: 30_000,
    // Every request logs an info line; hide them so test output shows what matters.
    // Spies (vi.spyOn(console, ...)) still see them.
    onConsoleLog: (line: string) => !line.startsWith('{"level":"info"'),
    hookTimeout: 120_000,
  },
});
