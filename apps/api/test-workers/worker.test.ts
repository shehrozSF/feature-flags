import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

// The real Worker entry in workerd. These requests are all rejected (or answered)
// before any database access, so no Postgres is needed: if the Worker did try the
// database here, the placeholder Hyperdrive URL would turn it into a 503/500.
const fetchWorker = (path: string, init?: RequestInit) =>
  exports.default.fetch(new Request(`http://worker${path}`, init));

const UUID = '3f2a6c1e-8b4d-4e7a-9c2f-1a2b3c4d5e6f';
const key = (kind: string) => `ff_${kind}_${UUID}_${'A'.repeat(43)}`;
const upgrade = { Upgrade: 'websocket' };

const problemStatus = async (res: Response) => {
  expect(res.headers.get('content-type')).toContain('application/problem+json');
  return (await res.json<{ status: number }>()).status;
};

describe('Worker entry', () => {
  it('health works in workerd', async () => {
    const res = await fetchWorker('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', version: 'dev' });
  });

  it('malformed keys are rejected before any database access', async () => {
    const res = await fetchWorker('/v1/flags', {
      headers: { Authorization: 'Bearer ff_admin_not-a-uuid_x' },
    });
    expect(res.status).toBe(401);
    expect(await problemStatus(res)).toBe(401);
  });

  it('unknown routes are problem+json 404s', async () => {
    const res = await fetchWorker('/nope');
    expect(res.status).toBe(404);
    expect(await problemStatus(res)).toBe(404);
  });
});

describe('stream routes', () => {
  it('stream without Upgrade gets 426', async () => {
    const res = await fetchWorker('/v1/sdk/stream', {
      headers: { Authorization: `Bearer ${key('server')}` },
    });
    expect(res.status).toBe(426);
    expect(await problemStatus(res)).toBe(426);
  });

  it('stream with a client key on the server stream gets 403', async () => {
    const res = await fetchWorker('/v1/sdk/stream', {
      headers: { ...upgrade, Authorization: `Bearer ${key('client')}` },
    });
    expect(res.status).toBe(403);
  });

  it('client stream takes its key from the query string', async () => {
    const missing = await fetchWorker('/v1/client/stream', { headers: upgrade });
    expect(missing.status).toBe(401);
    const wrongKind = await fetchWorker(`/v1/client/stream?key=${key('server')}`, {
      headers: upgrade,
    });
    expect(wrongKind.status).toBe(403);
  });
});

describe('CORS in the Worker', () => {
  it('the Worker allows its configured dashboard origin', async () => {
    const res = await fetchWorker('/v1/flags', {
      method: 'OPTIONS',
      headers: { origin: 'https://shehrozsf.github.io', 'access-control-request-method': 'GET' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://shehrozsf.github.io');
  });
});
