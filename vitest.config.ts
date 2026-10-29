import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**'],
      thresholds: {
        lines: 80,
        'packages/eval-core/src/**': { lines: 95, branches: 95 },
      },
    },
  },
});
