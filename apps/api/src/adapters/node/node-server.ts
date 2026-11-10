// The API as a plain Node server against Postgres: used by `pnpm dev` and by the
// smoke test. Production runs the same app on Cloudflare Workers; this mirrors its
// wiring, with in-memory hubs standing in for the ProjectHub Durable Objects.
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import pg from 'pg';
import { FlagService } from '../../domain/flags';
import { PostgresKeyVerifier, PostgresSnapshotSource } from '../../domain/postgres-sources';
import { SandboxService } from '../../domain/sandboxes';
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
}): Promise<NodeServer> {
  const pool = new pg.Pool({ connectionString: options.databaseUrl });
  const repo = new PostgresRepository(pool);
  const flags = new FlagService(repo);
  const sandboxes = new SandboxService(repo);
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
      rulesets: session,
      keys: session,
      notify,
      version: options.version ?? 'dev',
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
