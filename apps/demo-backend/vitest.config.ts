import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineProject } from 'vitest/config';

// demo-backend only runs on Workers, so its only test project is workerd.
export default defineProject({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      // The API Worker isn't part of these tests: a stand-in for its service binding,
      // so workerd can start. Tests that need the API pass their own fake.
      miniflare: {
        serviceBindings: { API: () => new Response('no API in these tests', { status: 503 }) },
      },
    }),
  ],
  test: {
    name: '@ff/demo-backend',
    include: ['test-workers/**/*.test.ts'],
    testTimeout: 30_000, // starting workerd under a loaded suite (issues #56)
  },
});
