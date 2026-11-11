// demo-backend: the demo shop's pricing endpoint (spec §3, §9.4). It evaluates the
// visitor's own sandbox flags with the server SDK in polling mode; the demo site
// forwards that sandbox's server key in a header (ADR 0030). Never logs the key.
// The deployed entry point is worker.ts; tests build their own with createWorker.
import type { Context } from '@ff/eval-core';
import { createClientCache } from './clients';

/** Prices in USD: the new price is what `new-pricing` turns on. */
export const NEW_PRICE = 19;
export const OLD_PRICE = 24;

const KEY_HEADER = 'x-ff-server-key';
const SERVER_KEY =
  /^ff_server_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_[0-9A-Za-z]{43}$/;

function problem(status: number, detail: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ type: 'about:blank', title: 'Error', status, detail }), {
    status,
    headers: { 'content-type': 'application/problem+json', ...headers },
  });
}

/** CORS for the demo shop's origins only (env.DEMO_ORIGINS, comma-separated). */
function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('origin');
  const allowed = env.DEMO_ORIGINS.split(',').map((o) => o.trim());
  return origin && allowed.includes(origin)
    ? { 'access-control-allow-origin': origin, vary: 'Origin' }
    : { vary: 'Origin' };
}

function visitor(url: URL): Context {
  const context: Context = {};
  for (const name of ['userId', 'plan', 'country'] as const) {
    const value = url.searchParams.get(name);
    if (value) context[name] = value;
  }
  return context;
}

/**
 * How the server SDK reaches the flag API. Deployed: through the service binding,
 * since a Worker can't fetch another Worker's workers.dev URL on the same account
 * (it gets a 404, issues #69); the binding ignores the URL's host and keeps the
 * path. Locally (`pnpm dev`, API_VIA=fetch): plain fetch to API_URL.
 */
function apiFetch(env: Env): typeof fetch {
  if (env.API_VIA === 'binding') {
    return (input, init) => env.API.fetch(input, init);
  }
  return globalThis.fetch.bind(globalThis);
}

export function createWorker(deps: { fetch?: typeof fetch; maxClients?: number } = {}) {
  let getClient: ReturnType<typeof createClientCache> | null = null;

  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const url = new URL(request.url);
      const cors = corsHeaders(request, env);

      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: cors['access-control-allow-origin']
            ? {
                ...cors,
                'access-control-allow-methods': 'GET',
                'access-control-allow-headers': KEY_HEADER,
                'access-control-max-age': '600',
              }
            : cors,
        });
      }
      if (url.pathname === '/health') return Response.json({ status: 'ok' }, { headers: cors });
      if (url.pathname !== '/price' || request.method !== 'GET') {
        return problem(404, 'no such route', cors);
      }

      const serverKey = request.headers.get(KEY_HEADER) ?? '';
      if (!SERVER_KEY.test(serverKey)) {
        return problem(400, `send the sandbox's server key in the ${KEY_HEADER} header`, cors);
      }

      getClient ??= createClientCache({
        apiUrl: env.API_URL,
        fetch: deps.fetch ?? apiFetch(env),
        max: deps.maxClients ?? 50,
      });
      const client = await getClient(serverKey);
      const context = visitor(url);
      // variation() first: in polling mode it is what starts a due revalidation
      // (or, with no rules yet, the next retry, within the SDK's backoff). Then hand
      // that work to waitUntil, or it is cut off when this response is sent (D29).
      const newPricing = client.variation('new-pricing', context, false);
      ctx.waitUntil(client.pending());

      if (client.version() === null) {
        // No rules: an unknown key, or the flag API is unreachable. We can't tell
        // which from here; the retry started above lets the key recover.
        return problem(503, "couldn't load this sandbox's flags; try again shortly", {
          ...cors,
          'retry-after': '5',
        });
      }

      return Response.json(
        {
          plan: context.plan ?? 'free',
          price: newPricing ? NEW_PRICE : OLD_PRICE,
          currency: 'USD',
          newPricing,
        },
        { headers: cors },
      );
    },
  } satisfies ExportedHandler<Env>;
}
