import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineProject } from 'vitest/config';

// Miniflare refuses to start a Hyperdrive binding without a local connection string.
// Workers tests never query Postgres (the hub has no database access) and Hyperdrive
// connects lazily, so a placeholder is enough; a real value from the shell wins.
process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE ??=
  'postgres://unused:unused@127.0.0.1:5432/unused';

// Runs test-workers/ inside workerd (via Miniflare) with the bindings from wrangler.jsonc.
export default defineProject({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
  test: {
    name: 'api-workers',
    include: ['test-workers/**/*.test.ts'],
    // The first test also pays for starting workerd, which is slow when the whole
    // suite runs under coverage (issues #56).
    testTimeout: 30_000,
    // Hide the per-request info lines (spies still see them).
    onConsoleLog: (line: string) => !line.startsWith('{"level":"info"'),
  },
});
