import { configDefaults, defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@ff/sdk-server',
    // test-workers/ runs in workerd through vitest.workers.config.ts.
    exclude: [...configDefaults.exclude, 'test-workers/**'],
    // The real-API test starts Postgres in Docker.
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});
