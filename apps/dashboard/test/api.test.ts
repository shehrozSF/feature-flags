import { describe, expect, it } from 'vitest';
import { ApiError, createAdminApi, createSandbox } from '../src/api';
import { fakeFetch, flag, json, KEYS, problem } from './fixtures';

// The dashboard's only way to the API. Every answer is checked against the
// contract, and every failure becomes an ApiError the UI can explain.
const BASE = 'http://api';
const api = (responses: Parameters<typeof fakeFetch>[0]) => {
  const f = fakeFetch(responses);
  return { api: createAdminApi({ baseUrl: BASE, adminKey: KEYS.admin, fetch: f.fetch }), ...f };
};
const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return (error as ApiError).problem;
  }
  throw new Error('expected an ApiError');
};

describe('admin API client', () => {
  it('lists flags with the admin key', async () => {
    const { api: a, requests } = api([() => json({ flags: [flag()] })]);
    expect(await a.listFlags()).toEqual([flag()]);
    expect(requests[0]).toMatchObject({
      method: 'GET',
      url: `${BASE}/v1/flags`,
      headers: { authorization: `Bearer ${KEYS.admin}` },
    });
  });

  it('updateFlag sends If-Match with the version', async () => {
    const { api: a, requests } = api([() => json(flag({ enabled: false, version: 2 }))]);
    const saved = await a.updateFlag('promo-banner', 1, { enabled: false });

    expect(requests[0]).toMatchObject({
      method: 'PATCH',
      url: `${BASE}/v1/flags/promo-banner`,
      headers: { 'if-match': '"1"', 'content-type': 'application/json' },
      body: { enabled: false },
    });
    expect(saved).toEqual({ value: flag({ enabled: false, version: 2 }), propagation: 'ok' });
  });

  it('x-propagation: delayed is reported', async () => {
    const { api: a } = api([
      () => json(flag({ version: 2 }), { headers: { 'x-propagation': 'delayed' } }),
    ]);
    expect((await a.updateFlag('promo-banner', 1, { name: 'x' })).propagation).toBe('delayed');
  });

  it('409 becomes a conflict carrying the current flag', async () => {
    const current = flag({ version: 3, enabled: false });
    const { api: a } = api([() => problem(409, { current })]);
    expect(await failure(a.updateFlag('promo-banner', 1, { enabled: true }))).toEqual({
      kind: 'conflict',
      current,
    });
  });

  it('409 on create (key already taken) becomes a field error on key', async () => {
    const { api: a } = api([() => problem(409, { detail: 'flag key is archived' })]);
    expect(await failure(a.createFlag({ key: 'x', name: 'X' } as never))).toEqual({
      kind: 'invalid',
      errors: [{ path: 'key', message: 'flag key is archived' }],
    });
    const { api: b } = api([() => problem(409)]);
    expect(await failure(b.createFlag({ key: 'x', name: 'X' } as never))).toEqual({
      kind: 'invalid',
      errors: [{ path: 'key', message: 'a flag with this key already exists' }],
    });
  });

  it('422 becomes invalid with field errors', async () => {
    const errors = [{ path: 'offVariant', message: 'must be one of the variants' }];
    const { api: a } = api([() => problem(422, { errors })]);
    expect(await failure(a.createFlag({ ...flag(), offVariant: 'nope' }))).toEqual({
      kind: 'invalid',
      errors,
    });
  });

  it('503 carries Retry-After', async () => {
    const { api: a } = api([() => problem(503)]);
    const p = await failure(a.listFlags());
    expect(p).toEqual({ kind: 'unavailable', retryAfterMs: 5000 }); // default when absent

    const { api: b } = api([
      () => new Response(null, { status: 503, headers: { 'retry-after': '2' } }),
    ]);
    expect(await failure(b.listFlags())).toEqual({ kind: 'unavailable', retryAfterMs: 2000 });
  });

  it('401, 403 and 404 have their own kinds', async () => {
    const { api: a } = api([() => problem(401), () => problem(403), () => problem(404)]);
    expect((await failure(a.listFlags())).kind).toBe('unauthorized');
    expect((await failure(a.listFlags())).kind).toBe('unauthorized');
    expect((await failure(a.getFlag('x'))).kind).toBe('not-found');
  });

  it("a response that doesn't match the contract becomes a network error, not a crash", async () => {
    const { api: a } = api([() => json({ flags: 'nope' })]);
    expect((await failure(a.listFlags())).kind).toBe('network');
  });

  it('a fetch that throws becomes a network error', async () => {
    const { api: a } = api([]); // fake fetch rejects
    expect((await failure(a.listFlags())).kind).toBe('network');
  });

  it('archiving answers 204 and reports propagation', async () => {
    const { api: a, requests } = api([() => new Response(null, { status: 204 })]);
    expect(await a.archiveFlag('promo-banner', 4)).toEqual({ value: null, propagation: 'ok' });
    expect(requests[0]).toMatchObject({ method: 'DELETE', headers: { 'if-match': '"4"' } });
  });

  it('creates a sandbox', async () => {
    const { fetch, requests } = fakeFetch([
      () =>
        json({ projectId: '3f2a6c1e-8b4d-4e7a-9c2f-1a2b3c4d5e6f', keys: KEYS }, { status: 201 }),
    ]);
    expect(await createSandbox(BASE, fetch)).toEqual({
      projectId: '3f2a6c1e-8b4d-4e7a-9c2f-1a2b3c4d5e6f',
      keys: KEYS,
    });
    expect(requests[0]).toMatchObject({ method: 'POST', url: `${BASE}/v1/sandboxes` });
  });
});
