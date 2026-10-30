import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*', 'tools/*', 'apps/*'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'apps/*/src/**'],
      exclude: ['apps/*/src/adapters/**'],
      thresholds: {
        lines: 80,
        'packages/eval-core/src/**': { lines: 95, branches: 95 },
      },
    },
  },
});
