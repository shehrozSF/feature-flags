import { describe, expect, it } from 'vitest';
import { createServerClient } from '../src/index';
import { ruleset } from '../test/fixtures';

// The demo backend (Phase 5) runs the server SDK in a Worker. This proves the SDK
// loads and evaluates in workerd itself, not just in Node.
describe('server SDK in workerd', () => {
  it('the server SDK runs in workerd in polling mode', async () => {
    expect(navigator.userAgent).toBe('Cloudflare-Workers'); // really in workerd

    const fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify(ruleset(1)), {
          headers: { 'content-type': 'application/json', etag: 'W/"1"' },
        }),
      );
    const client = await createServerClient({
      serverKey: 'k',
      baseUrl: 'https://api.example',
      mode: 'polling',
      fetch,
    });
    try {
      expect(client.version()).toBe(1);
      expect(client.variation('pk-local-payments', { userId: 'u', country: 'PK' }, false)).toBe(
        true,
      );
      await client.refresh(); // what a Worker hands to ctx.waitUntil
      expect(client.variation('cta-color', { userId: 'u' }, 'red')).toBe('blue');
    } finally {
      client.close();
    }
  });
});
