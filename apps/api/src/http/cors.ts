// CORS (spec §6.4). The dashboard and demo site run on another origin (GitHub
// Pages), so browsers only let their code read the API's answers if we say so:
// - client routes (/v1/client/*): any origin; the client key is public by design;
// - server routes (/v1/sdk/*) and /health: none; they are not for browsers;
// - everything else (admin routes, POST /v1/sandboxes): the dashboard only.
import type { MiddlewareHandler } from 'hono';

const ALLOW_METHODS = 'GET, POST, PATCH, DELETE';
const ALLOW_HEADERS = 'authorization, content-type, if-match, if-none-match';
// The SDKs and dashboard read these; browsers hide other headers cross-origin.
const EXPOSE_HEADERS = 'etag, x-propagation';
const MAX_AGE_SECONDS = '600';

type Audience = 'anyone' | 'dashboard' | 'nobody';

function audienceOf(path: string): Audience {
  if (path.startsWith('/v1/client/')) return 'anyone';
  if (path.startsWith('/v1/sdk/') || path === '/health') return 'nobody';
  return 'dashboard';
}

/** `dashboardOrigin` undefined: admin routes allow no origin at all. */
export function cors(dashboardOrigin: string | undefined): MiddlewareHandler {
  return async (c, next) => {
    const audience = audienceOf(c.req.path);
    const origin = c.req.header('origin');
    const allowed =
      audience === 'anyone'
        ? '*'
        : audience === 'dashboard' && origin !== undefined && origin === dashboardOrigin
          ? origin
          : null;
    // Admin answers differ by Origin, so caches must not mix them up.
    const vary: Record<string, string> = audience === 'dashboard' ? { vary: 'Origin' } : {};

    if (c.req.method === 'OPTIONS' && c.req.header('access-control-request-method')) {
      // Preflight. A disallowed origin gets a bare 204; the browser then blocks the call.
      if (!allowed) return c.body(null, 204, vary);
      return c.body(null, 204, {
        ...vary,
        'access-control-allow-origin': allowed,
        'access-control-allow-methods': ALLOW_METHODS,
        'access-control-allow-headers': ALLOW_HEADERS,
        'access-control-max-age': MAX_AGE_SECONDS,
      });
    }

    await next();
    // A WebSocket upgrade (101) has immutable headers, and CORS doesn't apply to it.
    if (c.res.status === 101) return;
    if (vary.vary) c.res.headers.append('vary', vary.vary);
    if (!allowed) return;
    // Errors too: otherwise the browser hides a 401 or 409 from the page's code.
    c.res.headers.set('access-control-allow-origin', allowed);
    c.res.headers.set('access-control-expose-headers', EXPOSE_HEADERS);
  };
}
