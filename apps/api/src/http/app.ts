// The HTTP API (spec §6.1). Built from a factory so tests, the Node server and
// the Worker (Phase 3) can each pass in their own dependencies.
import { EvaluateRequestSchema, exceedsJsonDepth, LIMITS, toFieldErrors } from '@ff/contracts';
import { evaluateAll } from '@ff/eval-core';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createMiddleware } from 'hono/factory';
import { routePath } from 'hono/route';
import { NotFoundError, ValidationError } from '../domain/errors';
import type { FlagService } from '../domain/flags';
import type { KeyVerifier, RulesetSource } from '../domain/ports';
import type { SandboxService } from '../domain/sandboxes';
import type { Notify } from '../hub/notifier';
import { log, requestIdFor, withRequestId } from '../log';
import { handleMcpRequest } from '../mcp/server';
import { MIN_SECRET_LENGTH } from '../mcp/confirm-token';
import type { CallApi } from '../mcp/tools';
import type { Take } from '../rate-limit';
import { requireKey, type AuthEnv } from './auth';
import { cors } from './cors';
import { formatEtag, parseEtag } from './etag';
import { BadJsonError, errorToProblem, problem, tooMany } from './problem';

export type AppDeps = {
  flags: FlagService;
  sandboxes: SandboxService;
  rulesets: RulesetSource;
  keys: KeyVerifier;
  /** Pushes a project's changes to its hub after a write. Absent = nothing to notify. */
  notify?: Notify;
  /** The dashboard's origin, allowed to call admin routes from a browser (spec §6.4). */
  dashboardOrigin?: string;
  /** Reported by /health, e.g. the git commit. */
  version: string;
  /**
   * Keeps background work (the activity write) alive after the response: the
   * Worker passes ctx.waitUntil. Default: just let it run (Node).
   */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Takes one sandbox creation from this IP's allowance (spec §9.2). Absent = no limit. */
  limitSandboxCreation?: (ip: string) => Promise<Take>;
  /**
   * Signs MCP confirm tokens (ADR 0038), at least 32 characters. Absent = MCP is
   * read-only: the write tools aren't offered at all.
   */
  mcpConfirmSecret?: string;
};

const MAX_BODY_BYTES = 64 * 1024;

async function readJson(c: Context): Promise<unknown> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new BadJsonError();
  }
  // Checked before any schema runs: the recursive JSON schema would overflow
  // the stack on very deep input (Phase 2 review #2).
  if (exceedsJsonDepth(body, LIMITS.jsonDepth)) {
    throw new ValidationError([
      { path: '', message: `JSON is nested more than ${LIMITS.jsonDepth} levels deep` },
    ]);
  }
  return body;
}

export function createApp(deps: AppDeps): Hono<AuthEnv> {
  // Fail at startup, not on the first propose_flag_change.
  if (deps.mcpConfirmSecret !== undefined && deps.mcpConfirmSecret.length < MIN_SECRET_LENGTH) {
    throw new Error(`MCP_CONFIRM_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  const app = new Hono<AuthEnv>();
  const adminKey = requireKey('admin', deps.keys);
  const waitUntil = deps.waitUntil ?? (() => undefined);
  // Every authenticated admin request counts as dashboard use, which keeps a
  // sandbox alive (spec §9.2). In the background: it must never slow or fail the request.
  const admin = createMiddleware<AuthEnv>((c, next) =>
    adminKey(c, async () => {
      const projectId = c.get('projectId');
      // async wrapper: a write that throws instead of rejecting is caught too.
      waitUntil(
        (async () => deps.sandboxes.touch(projectId))().catch((error: unknown) => {
          log('warn', 'activity write failed', { projectId, error });
        }),
      );
      await next();
    }),
  );

  // Runs after a write has committed. A failed push never undoes the write; the
  // client is told propagation is delayed (spec §9.1, as a header: plan decision 3).
  // If the project was deleted meanwhile, saying "saved" would be misleading: 404.
  const propagate = async (c: Context, projectId: string) => {
    const result = deps.notify ? await deps.notify(projectId) : 'ok';
    if (result === 'gone') throw new NotFoundError('project no longer exists');
    if (result === 'delayed') c.header('x-propagation', 'delayed');
  };

  // First, so every line logged while handling the request carries its id.
  app.use(async (c, next) => {
    const requestId = requestIdFor(c.req.header('cf-ray'));
    const started = Date.now();
    c.header('x-request-id', requestId);
    await withRequestId(requestId, async () => {
      await next();
      log('info', 'request', {
        method: c.req.method,
        route: routePath(c, -1), // the pattern, so flag keys and query strings stay out
        status: c.res.status,
        durationMs: Date.now() - started,
        projectId: c.get('projectId'),
      });
    });
  });
  app.use(cors(deps.dashboardOrigin));
  app.use(
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => problem(c, 413, `request bodies are limited to ${MAX_BODY_BYTES} bytes`),
    }),
  );

  app.get('/health', (c) => c.json({ status: 'ok', version: deps.version }));

  app.post('/v1/sandboxes', async (c) => {
    if (deps.limitSandboxCreation) {
      // Set by Cloudflare. Without it (never in production), every request shares
      // one bucket, so leaving the header out is no way around the limit.
      const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
      const taken = await deps.limitSandboxCreation(ip);
      if (!taken.ok) return tooMany(c, taken.retryAfterMs, 'sandboxes from your network');
    }
    const { evicted, ...sandbox } = await deps.sandboxes.create();
    // Evicted to stay under the cap: their keys must stop working now. The notifier
    // finds each project gone and clears its hub. After the response, like any
    // propagation: the new sandbox doesn't wait for it.
    for (const projectId of evicted) {
      if (deps.notify) waitUntil(deps.notify(projectId));
    }
    return c.json(sandbox, 201);
  });

  app.get('/v1/flags', admin, async (c) =>
    c.json({ flags: await deps.flags.list(c.get('projectId')) }),
  );

  app.post('/v1/flags', admin, async (c) => {
    const flag = await deps.flags.create(c.get('projectId'), await readJson(c));
    await propagate(c, c.get('projectId'));
    return c.json(flag, 201, { etag: formatEtag(flag.version) });
  });

  app.get('/v1/flags/:key', admin, async (c) => {
    const flag = await deps.flags.get(c.get('projectId'), c.req.param('key'));
    return c.json(flag, 200, { etag: formatEtag(flag.version) });
  });

  app.patch('/v1/flags/:key', admin, async (c) => {
    const flag = await deps.flags.update(
      c.get('projectId'),
      c.req.param('key'),
      parseEtag(c.req.header('if-match')),
      await readJson(c),
    );
    await propagate(c, c.get('projectId'));
    return c.json(flag, 200, { etag: formatEtag(flag.version) });
  });

  app.delete('/v1/flags/:key', admin, async (c) => {
    await deps.flags.archive(
      c.get('projectId'),
      c.req.param('key'),
      parseEtag(c.req.header('if-match')),
    );
    await propagate(c, c.get('projectId'));
    return c.body(null, 204);
  });

  // The MCP server for AI assistants (ADR 0037). Only POST (JSON-RPC). Left to the
  // transport, a stateless GET would open a server-to-client SSE stream that never
  // sends anything, holding a Worker request open; the MCP spec allows 405 instead.
  app.post('/mcp', admin, (c) => {
    // Tools re-enter this same app with the caller's key (ADR 0037), so each call is
    // checked and handled like any API request. cf-ray is passed on so the inner
    // requests log under the same request id as the MCP request.
    const forwarded: Record<string, string> = { authorization: c.req.header('authorization')! };
    const ray = c.req.header('cf-ray');
    if (ray) forwarded['cf-ray'] = ray;
    const callApi: CallApi = async (method, path, init = {}) => {
      const headers = { ...forwarded, ...init.headers };
      if (init.body === undefined) return app.request(path, { method, headers });
      return app.request(path, {
        method,
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(init.body),
      });
    };
    // Only "read" or nothing: a typo such as ?mode=readonly must not quietly give
    // the assistant write tools.
    const mode = c.req.query('mode');
    if (mode !== undefined && mode !== 'read') {
      return problem(c, 400, 'mode must be "read", or left out for read and write');
    }
    return handleMcpRequest(c.req.raw, {
      version: deps.version,
      callApi,
      projectId: c.get('projectId'),
      ...(deps.mcpConfirmSecret !== undefined ? { confirmSecret: deps.mcpConfirmSecret } : {}),
      readOnly: mode === 'read',
    });
  });
  app.on(['GET', 'DELETE'], '/mcp', (c) =>
    problem(c, 405, 'the MCP endpoint takes POST only (stateless)', {}, { allow: 'POST' }),
  );

  app.get('/v1/sdk/rules', requireKey('server', deps.keys), async (c) => {
    const ruleset = await deps.rulesets.getRuleset(c.get('projectId'));
    if (!ruleset) return problem(c, 401, 'unknown project');
    const etag = formatEtag(ruleset.projectVersion);
    if (parseEtag(c.req.header('if-none-match')) === ruleset.projectVersion) {
      return c.body(null, 304, { etag });
    }
    return c.json(ruleset, 200, { etag });
  });

  app.post('/v1/client/evaluate', requireKey('client', deps.keys), async (c) => {
    const parsed = EvaluateRequestSchema.safeParse(await readJson(c));
    if (!parsed.success) throw new ValidationError(toFieldErrors(parsed.error));
    const ruleset = await deps.rulesets.getRuleset(c.get('projectId'));
    if (!ruleset) return problem(c, 401, 'unknown project');
    return c.json({
      version: ruleset.projectVersion,
      flags: evaluateAll(ruleset, parsed.data.context),
    });
  });

  app.notFound((c) => problem(c, 404, 'no such route'));
  app.onError(errorToProblem);
  return app;
}
