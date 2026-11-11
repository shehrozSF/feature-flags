import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startNodeServer, type NodeServer } from '../../../apps/api/src/adapters/node/node-server';
import { createServerClient } from '../src/index';
import { silentLogger } from './fixtures';

// Every other SDK test uses the fake API. This one uses the real API (Node server,
// real Postgres, real sandbox, real PATCH), so if the fake and the real API ever
// disagree on something the SDK relies on, it shows up here.
const root = join(import.meta.dirname, '..', '..', '..');
let container: StartedPostgreSqlContainer;
let server: NodeServer;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  const migrated = spawnSync('corepack', ['pnpm', '--filter', '@ff/api', 'migrate'], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  expect(migrated.status, migrated.stderr).toBe(0);
  server = await startNodeServer({ databaseUrl: container.getConnectionUri(), port: 0 });
});

afterAll(async () => {
  await server?.close();
  await container?.stop();
});

describe('server SDK against the real API', () => {
  it('polling mode works against the real Node API', async () => {
    const sandbox = (await (
      await fetch(`${server.url}/v1/sandboxes`, { method: 'POST' })
    ).json()) as {
      keys: { admin: string; server: string };
    };
    const client = await createServerClient({
      serverKey: sandbox.keys.server,
      baseUrl: server.url,
      mode: 'polling',
      logger: silentLogger().logger,
    });
    try {
      // The seeded flags of spec §9.4, evaluated locally from the real ruleset.
      expect(client.variation('pk-local-payments', { userId: 'u', country: 'PK' }, false)).toBe(
        true,
      );
      expect(client.variation('promo-banner', { userId: 'u' }, false)).toBe(true);

      const patch = await fetch(`${server.url}/v1/flags/promo-banner`, {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${sandbox.keys.admin}`,
          'if-match': '"1"',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ enabled: false }),
      });
      expect(patch.status).toBe(200);

      await client.refresh();
      expect(client.variation('promo-banner', { userId: 'u' }, true)).toBe(false);
      expect(client.version()).toBe(2);
    } finally {
      client.close();
    }
  });
});
