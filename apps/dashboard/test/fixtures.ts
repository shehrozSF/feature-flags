import type { FlagResource } from '@ff/contracts';

export const KEYS = {
  admin: `ff_admin_3f2a6c1e-8b4d-4e7a-9c2f-1a2b3c4d5e6f_${'A'.repeat(43)}`,
  server: `ff_server_3f2a6c1e-8b4d-4e7a-9c2f-1a2b3c4d5e6f_${'B'.repeat(43)}`,
  client: `ff_client_3f2a6c1e-8b4d-4e7a-9c2f-1a2b3c4d5e6f_${'C'.repeat(43)}`,
};

/** A flag as the API returns it (like the seeded promo-banner). */
export const flag = (overrides: Partial<FlagResource> = {}): FlagResource => ({
  key: 'promo-banner',
  name: 'Promo banner',
  description: 'Shows the banner at the top of the demo shop.',
  enabled: true,
  variants: [
    { key: 'on', value: true },
    { key: 'off', value: false },
  ],
  offVariant: 'off',
  rules: [],
  defaultServe: { variant: 'on' },
  salt: 'salt-1',
  version: 1,
  updatedAt: '2026-11-11T10:00:00.000Z',
  ...overrides,
});

export const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });

export const problem = (status: number, extra: object = {}) =>
  json(
    { type: 'about:blank', title: 'Error', status, ...extra },
    {
      status,
      headers: { 'content-type': 'application/problem+json' },
    },
  );

/** A fetch that answers from a queue and records each request. */
export function fakeFetch(responses: (() => Response | Promise<Response>)[]) {
  const requests: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: unknown;
  }[] = [];
  const fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requests.push({
      method: init?.method ?? 'GET',
      url: input instanceof Request ? input.url : input.toString(),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const next = responses.shift();
    if (!next) return Promise.reject(new Error('no scripted response left'));
    return Promise.resolve(next());
  };
  return { fetch, requests };
}
