// Runs the API as a plain Node server against Postgres, for local development
// and debugging. Production runs the same app on Cloudflare Workers (Phase 3).
import { serve } from '@hono/node-server';
import pg from 'pg';
import { FlagService } from '../../domain/flags';
import { PostgresKeyVerifier, PostgresRulesetSource } from '../../domain/postgres-sources';
import { SandboxService } from '../../domain/sandboxes';
import { createApp } from '../../http/app';
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
const app = createApp({
  flags: new FlagService(repo),
  sandboxes: new SandboxService(repo),
  rulesets: new PostgresRulesetSource(repo),
  keys: new PostgresKeyVerifier(repo),
  version: process.env.GIT_SHA ?? 'dev',
});

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => console.log(`API listening on http://localhost:${port}`));
