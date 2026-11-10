// The production entry: the same Hono app as the Node server, wired per request
// to Postgres (through Hyperdrive) and the per-project ProjectHub Durable Objects.
import { createMiddleware } from 'hono/factory';
import pg from 'pg';
import { FlagService } from '../../domain/flags';
import { PostgresKeyVerifier, PostgresSnapshotSource } from '../../domain/postgres-sources';
import { SandboxService } from '../../domain/sandboxes';
import { createApp } from '../../http/app';
import { requireKey, type AuthEnv } from '../../http/auth';
import { problem } from '../../http/problem';
import type { HubClient } from '../../hub/hub-client';
import { HubSession } from '../../hub/hub-session';
import { createNotifier } from '../../hub/notifier';
import { PostgresRepository } from '../../repo/postgres';
import type { Env } from './env';

export { ProjectHub } from './project-hub';

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
    const session = new HubSession({
      hub,
      snapshots,
      postgresKeys: new PostgresKeyVerifier(repo),
      waitUntil: (promise) => {
        background.push(promise);
        ctx.waitUntil(promise);
      },
    });

    const app = createApp({
      flags: new FlagService(repo),
      sandboxes: new SandboxService(repo),
      rulesets: session,
      keys: session,
      notify: createNotifier({ hub, snapshots }),
      version: env.GIT_SHA ?? 'dev',
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
} satisfies ExportedHandler<Env>;
