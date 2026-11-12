// The production entry: the same Hono app as the Node server, wired per request
// to Postgres (through Hyperdrive) and the per-project ProjectHub Durable Objects.
import { LIMITS } from '@ff/contracts';
import { createMiddleware } from 'hono/factory';
import pg from 'pg';
import { FlagService } from '../../domain/flags';
import { PostgresKeyVerifier, PostgresSnapshotSource } from '../../domain/postgres-sources';
import { purgeExpired } from '../../domain/purge';
import { SandboxService } from '../../domain/sandboxes';
import { WebhookService } from '../../domain/webhooks';
import { createDispatcher } from '../../webhooks/dispatcher';
import { createApp } from '../../http/app';
import { requireKey, type AuthEnv } from '../../http/auth';
import { problem } from '../../http/problem';
import type { HubClient } from '../../hub/hub-client';
import { log } from '../../log';
import { HubSession } from '../../hub/hub-session';
import { createNotifier } from '../../hub/notifier';
import { PostgresRepository } from '../../repo/postgres';
import type { Env } from './env';

const HOUR_MS = 60 * 60 * 1000;

export { ProjectHub } from './project-hub';
export { RateLimiter } from './rate-limiter';

const requireUpgrade = createMiddleware<AuthEnv>(async (c, next) => {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
    const detail = 'this route only accepts WebSocket connections';
    return problem(c, 426, detail, {}, { upgrade: 'websocket' });
  }
  await next();
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Hyperdrive pools the real database connections; this pool only lives for one
    // request, so a few connections are plenty.
    const pool = new pg.Pool({ connectionString: env.HYPERDRIVE.connectionString, max: 5 });
    const repo = new PostgresRepository(pool);
    const snapshots = new PostgresSnapshotSource(repo);
    const stub = (projectId: string) => env.PROJECT_HUB.getByName(projectId);
    // HubClient, not the generated stub type: that one is too deep for tsc (issues #40).
    const hub = (projectId: string) => stub(projectId) as unknown as HubClient;

    const background: Promise<unknown>[] = [];
    const waitUntil = (promise: Promise<unknown>) => {
      background.push(promise);
      ctx.waitUntil(promise);
    };
    const session = new HubSession({
      hub,
      snapshots,
      postgresKeys: new PostgresKeyVerifier(repo),
      waitUntil,
    });

    const app = createApp({
      flags: new FlagService(repo),
      sandboxes: new SandboxService(repo),
      webhooks: new WebhookService(repo), // https only in production (ADR 0039)
      // Runs through waitUntil, so it's in `background` and the pool outlives it.
      dispatch: createDispatcher({ webhooks: repo }),
      rulesets: session,
      keys: session,
      notify: createNotifier({ hub, snapshots }),
      dashboardOrigin: env.DASHBOARD_ORIGIN,
      version: env.GIT_SHA ?? 'dev',
      waitUntil,
      limitSandboxCreation: (ip) =>
        env.RATE_LIMITER.getByName(`sandbox:${ip}`).take(LIMITS.sandboxCreatesPerHour, HOUR_MS),
      // A too-short secret makes createApp throw, so every request fails and the
      // deploy's /health check rolls the release back (ADR 0035), instead of MCP
      // quietly signing with a weak secret.
      ...(env.MCP_CONFIRM_SECRET ? { mcpConfirmSecret: env.MCP_CONFIRM_SECRET } : {}),
    });

    // Stream routes (spec §6.3): Worker-only, since the Node server has no sockets.
    // Checked here, then handed to the project's hub, which owns the socket.
    app.get('/v1/sdk/stream', requireUpgrade, requireKey('server', session), (c) =>
      stub(c.get('projectId')).fetch(c.req.raw),
    );
    app.get('/v1/client/stream', requireUpgrade, requireKey('client', session, 'query'), (c) =>
      stub(c.get('projectId')).fetch(c.req.raw),
    );

    try {
      return await app.fetch(request, env, ctx);
    } finally {
      // Close the pool only after background work (stale refreshes) has used it.
      ctx.waitUntil(Promise.allSettled(background).then(() => pool.end()));
    }
  },

  // The hourly Cron Trigger (wrangler.jsonc): deletes expired sandboxes (spec §9.2).
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const pool = new pg.Pool({ connectionString: env.HYPERDRIVE.connectionString, max: 2 });
    const hub = (projectId: string) => env.PROJECT_HUB.getByName(projectId) as unknown as HubClient;
    try {
      const { deleted } = await purgeExpired({ repo: new PostgresRepository(pool), hub });
      log('info', 'sandboxes purged', { count: deleted });
    } catch (error) {
      // Nothing to undo: the next hourly run tries again.
      log('error', 'purge failed', { error });
    } finally {
      await pool.end().catch(() => undefined);
    }
  },
} satisfies ExportedHandler<Env>;
