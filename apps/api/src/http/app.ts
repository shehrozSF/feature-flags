// The HTTP API (spec §6.1). Built from a factory so tests, the Node server and
// the Worker (Phase 3) can each pass in their own dependencies.
import { EvaluateRequestSchema, toFieldErrors } from '@ff/contracts';
import { evaluateAll } from '@ff/eval-core';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { ValidationError } from '../domain/errors';
import type { FlagService } from '../domain/flags';
import type { KeyVerifier, RulesetSource } from '../domain/ports';
import type { SandboxService } from '../domain/sandboxes';
import { requireKey, type AuthEnv } from './auth';
import { formatEtag, parseEtag } from './etag';
import { BadJsonError, errorToProblem, problem } from './problem';

export type AppDeps = {
  flags: FlagService;
  sandboxes: SandboxService;
  rulesets: RulesetSource;
  keys: KeyVerifier;
  /** Reported by /health, e.g. the git commit. */
  version: string;
};

const MAX_BODY_BYTES = 64 * 1024;

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new BadJsonError();
  }
}

export function createApp(deps: AppDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  const admin = requireKey('admin', deps.keys);

  app.use(
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => problem(c, 413, `request bodies are limited to ${MAX_BODY_BYTES} bytes`),
    }),
  );

  app.get('/health', (c) => c.json({ status: 'ok', version: deps.version }));

  app.post('/v1/sandboxes', async (c) => c.json(await deps.sandboxes.create(), 201));

  app.get('/v1/flags', admin, async (c) =>
    c.json({ flags: await deps.flags.list(c.get('projectId')) }),
  );

  app.post('/v1/flags', admin, async (c) => {
    const flag = await deps.flags.create(c.get('projectId'), await readJson(c));
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
    return c.json(flag, 200, { etag: formatEtag(flag.version) });
  });

  app.delete('/v1/flags/:key', admin, async (c) => {
    await deps.flags.archive(
      c.get('projectId'),
      c.req.param('key'),
      parseEtag(c.req.header('if-match')),
    );
    return c.body(null, 204);
  });

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
