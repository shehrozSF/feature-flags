// The API as a plain Node server against Postgres: used by `pnpm dev` and by the
// smoke test. Production runs the same app on Cloudflare Workers; this mirrors its
// wiring, with in-memory hubs standing in for the ProjectHub Durable Objects.
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import pg from 'pg';
import { FlagService } from '../../domain/flags';
import { PostgresKeyVerifier, PostgresSnapshotSource } from '../../domain/postgres-sources';
import { SandboxService } from '../../domain/sandboxes';
import { WebhookService } from '../../domain/webhooks';
import { createDispatcher } from '../../webhooks/dispatcher';
import { createApp } from '../../http/app';
import { HubSession } from '../../hub/hub-session';
import { memoryHubs } from '../../hub/memory-hub';
import { createNotifier } from '../../hub/notifier';
import { PostgresRepository } from '../../repo/postgres';

export type NodeServer = { url: string; close: () => Promise<void> };

/** port 0 picks a free port; the chosen one is in `url`. */
export async function startNodeServer(options: {
  databaseUrl: string;
  port: number;
  version?: string;
  /** Allowed to call admin routes from a browser. Default: the dashboard's Vite dev server. */
  dashboardOrigin?: string;
  /** Signs MCP confirm tokens; absent = MCP is read-only (ADR 0038). */
  mcpConfirmSecret?: string;
}): Promise<NodeServer> {
  const pool = new pg.Pool({ connectionString: options.databaseUrl });
  const repo = new PostgresRepository(pool);
  const flags = new FlagService(repo);
  const sandboxes = new SandboxService(repo);
  // Local development: also http://localhost, so a local n8n can receive events.
  const webhooks = new WebhookService(repo, { allowLocalHttp: true });
  const dispatch = createDispatcher({ webhooks: repo });
  const snapshots = new PostgresSnapshotSource(repo);
  const postgresKeys = new PostgresKeyVerifier(repo);
  // Live as long as the process, like Durable Objects live across requests.
  const hub = memoryHubs();
  const notify = createNotifier({ hub, snapshots });

  // A HubSession belongs to one request, so build the app per request (as the Worker does).
  const fetch = (request: Request) => {
    const session = new HubSession({
      hub,
      snapshots,
      postgresKeys,
      // Node keeps running after the response, so background work needs no help.
      waitUntil: (promise) => void promise,
    });
    return createApp({
      flags,
      sandboxes,
      webhooks,
      dispatch,
      rulesets: session,
      keys: session,
      notify,
      dashboardOrigin: options.dashboardOrigin ?? 'http://localhost:5173',
      version: options.version ?? 'dev',
      ...(options.mcpConfirmSecret ? { mcpConfirmSecret: options.mcpConfirmSecret } : {}),
    }).fetch(request);
  };

  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch, port: options.port }, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await pool.end();
    },
  };
}
