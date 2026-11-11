import type { Result } from '@ff/eval-core';

type Flags = Record<string, Result>;

/** An evaluate response body: { version, flags }. */
export const results = (version: number, promoOn = true, extra: Flags = {}) => ({
  version,
  flags: {
    'promo-banner': promoOn
      ? { variant: 'on', value: true, reason: 'DEFAULT' as const }
      : { variant: 'off', value: false, reason: 'OFF' as const },
    'cta-color': { variant: 'blue', value: 'blue', reason: 'DEFAULT' as const },
    ...extra,
  },
});

export const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });

/**
 * A fetch the test answers by hand: each call waits until the test resolves it,
 * so tests control exactly which response arrives first.
 */
export function manualFetch() {
  const calls: {
    url: string;
    body: unknown;
    headers: Record<string, string>;
    respond(r: Response): void;
  }[] = [];
  const fetch = (input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((resolve) => {
      calls.push({
        url: input instanceof Request ? input.url : input.toString(),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        respond: resolve,
      });
    });
  return { fetch, calls };
}

/** A Storage whose every method throws, like a blocked or full localStorage. */
export const throwingStorage = (): Storage =>
  new Proxy({} as Storage, {
    get() {
      throw new DOMException('blocked', 'SecurityError');
    },
  });
