import type { Flag, Ruleset } from '@ff/eval-core';

const onOff = [
  { key: 'on', value: true },
  { key: 'off', value: false },
];

/** A small ruleset like the seeded sandbox (spec §9.4); `promoOn` lets tests change it. */
export function ruleset(projectVersion: number, promoOn = true): Ruleset {
  const flags: Flag[] = [
    {
      key: 'promo-banner',
      enabled: promoOn,
      variants: onOff,
      offVariant: 'off',
      rules: [],
      defaultServe: { variant: 'on' },
      salt: 'promo',
      version: projectVersion,
    },
    {
      key: 'pk-local-payments',
      enabled: true,
      variants: onOff,
      offVariant: 'off',
      rules: [
        {
          id: 'pakistan',
          conditions: [{ attribute: 'country', op: 'in', values: ['PK'] }],
          serve: { variant: 'on' },
        },
      ],
      defaultServe: { variant: 'off' },
      salt: 'pk',
      version: 1,
    },
    {
      key: 'cta-color',
      enabled: true,
      variants: [
        { key: 'blue', value: 'blue' },
        { key: 'green', value: 'green' },
      ],
      offVariant: 'blue',
      rules: [],
      defaultServe: { variant: 'blue' },
      salt: 'cta',
      version: 1,
    },
  ];
  return { projectVersion, flags: Object.fromEntries(flags.map((f) => [f.key, f])) };
}

/** A fetch that answers from a queue of canned responses, recording every call. */
export function scriptedFetch(responses: (() => Response | Promise<Response>)[]) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: input instanceof Request ? input.url : input.toString(),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    const next = responses.shift();
    return next ? Promise.resolve(next()) : new Promise<Response>(() => undefined);
  };
  return { fetch, calls };
}

export const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });

export const silentLogger = () => {
  const warnings: string[] = [];
  return { warnings, logger: { warn: (m: string) => warnings.push(m) } };
};
