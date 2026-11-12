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
let apiWithMcpWrites;

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
  // The same database, with the MCP confirm secret set, as production has it.
  apiWithMcpWrites = await startNodeServer({
    databaseUrl,
    port: 0,
    mcpConfirmSecret: 'smoke-test-secret-that-is-long-enough-0123',
  });
}, 180_000);

afterAll(async () => {
  await api?.close();
  await apiWithMcpWrites?.close();
  await container?.stop();
});

describe('smoke.mjs', () => {
  it('passes against a healthy API', async () => {
    const run = await smoke([api.url, '--no-websocket']);
    expect(run.status, run.stderr).toBe(0);
    for (const check of [
      'health',
      'sandbox',
      'client evaluate',
      'sdk rules',
      'propagation',
      'mcp',
    ]) {
      expect(run.stdout).toContain(`✓ ${check}`);
    }
    expect(run.stdout).toContain('- websocket (skipped)');
    // This server has no confirm secret: MCP is read-only, which is fine without --mcp-writes.
    expect(run.stdout).toContain('read-only (no confirm secret)');
  }, 60_000);

  it('with the confirm secret, MCP propose + apply runs end to end', async () => {
    const run = await smoke([apiWithMcpWrites.url, '--no-websocket', '--mcp-writes']);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('propose + apply turned promo-banner back on');
    expect(run.stdout + run.stderr).not.toMatch(/ff_admin_|v1\.[\w-]+\.[\w-]+/); // no keys or tokens printed
  }, 60_000);

  it('--mcp-writes fails a deploy whose Worker has no confirm secret', async () => {
    const run = await smoke([api.url, '--no-websocket', '--mcp-writes']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('✗ mcp');
    expect(run.stderr).toContain('is MCP_CONFIRM_SECRET set on the Worker?');
  }, 60_000);

  it('--fail runs every check, then exits 1 on purpose (to rehearse a rollback)', async () => {
    const run = await smoke([api.url, '--no-websocket', '--fail']);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('✓ propagation'); // the real checks all ran and passed
    expect(run.stderr).toContain('failing on purpose (--fail)');
  }, 60_000);

  it('a stream that never connects fails, after 3 tries 1 s apart', async () => {
    // The Node server has no stream route (Worker only), so every upgrade is refused.
    const run = await smoke([api.url]);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('websocket try 1 failed');
    expect(run.stdout).toContain('websocket try 2 failed');
    expect(run.stderr).toContain('✗ websocket: WebSocket error on hello'); // the 3rd try's error
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

  it('checks CORS from the dashboard origin', async () => {
    // The Node server's dashboard origin is http://localhost:5173 (its default).
    const ok = await smoke([
      api.url,
      '--no-websocket',
      '--dashboard-origin',
      'http://localhost:5173',
    ]);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain('✓ cors');

    const wrong = await smoke([
      api.url,
      '--no-websocket',
      '--dashboard-origin',
      'https://wrong.example',
    ]);
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain('✗ cors');

    const skipped = await smoke([api.url, '--no-websocket']);
    expect(skipped.stdout).toContain('- cors (skipped)');
  }, 60_000);

  it('checks the pricing backend when given one', async () => {
    // A stand-in for demo-backend: it must get the sandbox's server key in the header.
    const seen = [];
    let healthy = true;
    const backend = createServer((req, res) => {
      seen.push({ url: req.url, key: req.headers['x-ff-server-key'] });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok' }));
      if (!healthy) {
        res.statusCode = 503;
        return res.end('{}');
      }
      res.end(JSON.stringify({ plan: 'pro', price: 19, currency: 'USD', newPricing: true }));
    });
    await new Promise((r) => backend.listen(0, r));
    const url = `http://127.0.0.1:${backend.address().port}`;
    try {
      const ok = await smoke([api.url, '--no-websocket', '--backend', url]);
      expect(ok.status, ok.stderr).toBe(0);
      expect(ok.stdout).toContain('✓ pricing backend');
      const price = seen.find((s) => s.url.startsWith('/price'));
      expect(price.url).toContain('plan=pro');
      expect(price.key).toMatch(/^ff_server_/);
      expect(ok.stdout + ok.stderr).not.toContain(price.key); // keys are never printed

      healthy = false;
      const down = await smoke([api.url, '--no-websocket', '--backend', url]);
      expect(down.status).toBe(1);
      expect(down.stderr).toContain('✗ pricing backend');
      expect(down.stderr).toContain('503'); // says why, not just that it failed
    } finally {
      await new Promise((r) => backend.close(r));
    }
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
