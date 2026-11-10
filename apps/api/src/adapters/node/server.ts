// Runs the API as a plain Node server against Postgres, for local development
// and debugging. Production runs the same app on Cloudflare Workers; this mirrors
// its wiring, with in-memory hubs standing in for the ProjectHub Durable Objects.
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

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(
    'Set DATABASE_URL, e.g. postgres://ff:ff@localhost:5432/ff (see docker-compose.yml)',
  );
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: databaseUrl });
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
    version: process.env.GIT_SHA ?? 'dev',
  }).fetch(request);
};

const port = Number(process.env.PORT ?? 8787);
serve({ fetch, port }, () => console.log(`API listening on http://localhost:${port}`));
