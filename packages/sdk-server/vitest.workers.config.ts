import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineProject } from 'vitest/config';

// Runs test-workers/ inside workerd: Workers use the server SDK in polling mode
// (spec §8.1), so it must not depend on anything Node-only.
export default defineProject({
  plugins: [
    cloudflareTest({
      miniflare: { compatibilityDate: '2026-10-15', compatibilityFlags: ['nodejs_compat'] },
    }),
  ],
  test: {
    name: 'sdk-server-workers',
    include: ['test-workers/**/*.test.ts'],
    testTimeout: 30_000, // starting workerd under a loaded suite (issues #56)
  },
});
