// Tests for the smoke script. It runs as a child process, exactly as CI runs it,
// against the real Node server (in this process) on a throwaway Postgres.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startNodeServer } from '../../apps/api/src/adapters/node/node-server';

const here = import.meta.dirname;
const root = join(here, '..', '..');

/** Async, so this process's server can keep answering while the script runs. */
function smoke(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, 'smoke.mjs'), ...args], {
      env: { ...process.env, GITHUB_STEP_SUMMARY: '', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

let container;
let api;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  const databaseUrl = container.getConnectionUri();
  // The real migrate CLI, as CI's deploy job will run it.
  const migrated = spawnSync('corepack', ['pnpm', '--filter', '@ff/api', 'migrate'], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  expect(migrated.status, migrated.stderr).toBe(0);
  api = await startNodeServer({ databaseUrl, port: 0 });
}, 180_000);

afterAll(async () => {
  await api?.close();
  await container?.stop();
});

describe('smoke.mjs', () => {
  it('passes against a healthy API', async () => {
    const run = await smoke([api.url, '--no-websocket']);
    expect(run.status, run.stderr).toBe(0);
    for (const check of ['health', 'sandbox', 'client evaluate', 'sdk rules', 'propagation']) {
      expect(run.stdout).toContain(`✓ ${check}`);
    }
    expect(run.stdout).toContain('- websocket (skipped)');
  }, 60_000);

  it('fails clearly when the API is down', async () => {
    const closed = createServer();
    await new Promise((r) => closed.listen(0, r));
    const { port } = closed.address();
    await new Promise((r) => closed.close(r)); // nothing listens there now

    const run = await smoke([`http://127.0.0.1:${port}`, '--no-websocket']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('✗ health');
    expect(run.stderr).toContain('/health');
  }, 60_000);

  it('names the failing check when an answer is wrong', async () => {
    // Healthy, but sandboxes are broken: the run must stop at the sandbox check.
    const fake = createServer((req, res) => {
      if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok', version: 'x' }));
      res.statusCode = 500;
      res.end('{}');
    });
    await new Promise((r) => fake.listen(0, r));
    const run = await smoke([`http://127.0.0.1:${fake.address().port}`, '--no-websocket']);
    await new Promise((r) => fake.close(r));

    expect(run.status).toBe(1);
    expect(run.stdout).toContain('✓ health');
    expect(run.stderr).toContain('✗ sandbox');
    expect(run.stderr).toContain('500');
  }, 60_000);

  it('writes a summary for GitHub Actions when asked', async () => {
    const summary = join(mkdtempSync(join(tmpdir(), 'smoke-')), 'summary.md');
    const run = await smoke([api.url, '--no-websocket'], { GITHUB_STEP_SUMMARY: summary });
    expect(run.status, run.stderr).toBe(0);
    const text = readFileSync(summary, 'utf8');
    expect(text).toContain('Smoke test');
    expect(text).toContain('| health | ✓ |');
  }, 60_000);
});
