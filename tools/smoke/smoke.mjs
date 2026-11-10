#!/usr/bin/env node
// Smoke test: a few fast end-to-end checks against a running API, e.g. right after
// a deploy. Usage: node tools/smoke/smoke.mjs <baseUrl> [--no-websocket]
// Exits 0 if every check passes, 1 at the first failure (named on stderr). With
// GITHUB_STEP_SUMMARY set (GitHub Actions), it also appends a results table there.
// It creates its own sandbox, so it never touches anyone else's data.
import { appendFileSync } from 'node:fs';

const TIMEOUT_MS = 10_000;
const CHANGE_WAIT_MS = 5_000;

const args = process.argv.slice(2);
const base = args.find((a) => !a.startsWith('--'))?.replace(/\/+$/, '');
const withWebSocket = !args.includes('--no-websocket');
if (!base) {
  console.error('usage: node tools/smoke/smoke.mjs <baseUrl> [--no-websocket]');
  process.exit(2);
}

class CheckFailed extends Error {}
const fail = (message) => {
  throw new CheckFailed(message);
};

async function request(method, path, { key, body, headers = {} } = {}) {
  const url = `${base}${path}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    fail(
      `${method} ${path}: ${error.cause?.code ?? error.name}: ${error.cause?.message ?? error.message}`,
    );
  }
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, json, text };
}

function expectStatus(res, status, what) {
  if (res.status !== status) {
    fail(`${what}: expected ${status}, got ${res.status} ${res.text.slice(0, 200)}`);
  }
}

const state = {};

const checks = [
  [
    'health',
    async () => {
      const res = await request('GET', '/health');
      expectStatus(res, 200, 'GET /health');
      if (res.json?.status !== 'ok') fail(`GET /health: status is ${res.json?.status}`);
      return `version ${res.json.version}`;
    },
  ],
  [
    'sandbox',
    async () => {
      const res = await request('POST', '/v1/sandboxes');
      expectStatus(res, 201, 'POST /v1/sandboxes');
      const keys = res.json?.keys;
      if (!keys?.admin || !keys?.server || !keys?.client) fail('POST /v1/sandboxes: missing keys');
      state.keys = keys;
      return `project ${res.json.projectId}`;
    },
  ],
  [
    'client evaluate',
    async () => {
      const result = await evaluate();
      if (result['pk-local-payments']?.variant !== 'on') {
        fail(`pk-local-payments for country PK is ${JSON.stringify(result['pk-local-payments'])}`);
      }
      return 'pk-local-payments is on for PK';
    },
  ],
  [
    'sdk rules',
    async () => {
      const res = await request('GET', '/v1/sdk/rules', { key: state.keys.server });
      expectStatus(res, 200, 'GET /v1/sdk/rules');
      const count = Object.keys(res.json?.flags ?? {}).length;
      if (count !== 4) fail(`GET /v1/sdk/rules: expected 4 flags, got ${count}`);
      const etag = res.headers.get('etag');
      if (!etag) fail('GET /v1/sdk/rules: no ETag');
      const again = await request('GET', '/v1/sdk/rules', {
        key: state.keys.server,
        headers: { 'if-none-match': etag },
      });
      expectStatus(again, 304, 'GET /v1/sdk/rules with If-None-Match');
      return `4 flags, ETag ${etag}, then 304`;
    },
  ],
  [
    'propagation',
    async () => {
      const res = await request('PATCH', '/v1/flags/promo-banner', {
        key: state.keys.admin,
        body: { enabled: false },
        headers: { 'if-match': '"1"' },
      });
      expectStatus(res, 200, 'PATCH /v1/flags/promo-banner');
      if (res.headers.get('x-propagation'))
        fail(`PATCH: x-propagation: ${res.headers.get('x-propagation')}`);
      const result = await evaluate();
      if (result['promo-banner']?.variant !== 'off') {
        fail(`promo-banner after disabling is ${JSON.stringify(result['promo-banner'])}`);
      }
      return 'disabled promo-banner, evaluate sees it off';
    },
  ],
  ['websocket', withWebSocket ? websocketCheck : null],
];

async function evaluate() {
  const res = await request('POST', '/v1/client/evaluate', {
    key: state.keys.client,
    body: { context: { userId: 'smoke', country: 'PK' } },
  });
  expectStatus(res, 200, 'POST /v1/client/evaluate');
  return res.json?.flags ?? {};
}

/** hello on connect, then `changed` within 5 s of a write. */
async function websocketCheck() {
  const url = `${base.replace(/^http/, 'ws')}/v1/client/stream?key=${state.keys.client}`;
  const ws = new WebSocket(url);
  const messages = [];
  const waiters = [];
  ws.addEventListener('message', (e) => {
    messages.push(JSON.parse(String(e.data)));
    for (const w of [...waiters]) w();
  });
  const waitFor = (predicate, ms, what) =>
    new Promise((resolve, reject) => {
      const check = () => {
        const found = messages.find(predicate);
        if (!found) return;
        clearTimeout(timer);
        waiters.splice(waiters.indexOf(check), 1);
        resolve(found);
      };
      const timer = setTimeout(() => reject(new CheckFailed(`no ${what} within ${ms} ms`)), ms);
      waiters.push(check);
      ws.addEventListener('error', () => reject(new CheckFailed(`WebSocket error on ${what}`)));
      check();
    });
  try {
    const hello = await waitFor((m) => m.type === 'hello', TIMEOUT_MS, 'hello');
    const flag = await request('GET', '/v1/flags/promo-banner', { key: state.keys.admin });
    expectStatus(flag, 200, 'GET /v1/flags/promo-banner');
    const res = await request('PATCH', '/v1/flags/promo-banner', {
      key: state.keys.admin,
      body: { enabled: !flag.json.enabled },
      headers: { 'if-match': flag.headers.get('etag') },
    });
    expectStatus(res, 200, 'PATCH /v1/flags/promo-banner (for the socket)');
    const changed = await waitFor(
      (m) => m.type === 'changed' && m.version > hello.version,
      CHANGE_WAIT_MS,
      '"changed" message',
    );
    return `hello v${hello.version}, changed v${changed.version}`;
  } finally {
    ws.close();
  }
}

const rows = [];
let failed = false;
for (const [name, run] of checks) {
  if (!run) {
    console.log(`- ${name} (skipped)`);
    rows.push([name, 'skipped', '']);
    continue;
  }
  const started = Date.now();
  try {
    const note = await run();
    const ms = Date.now() - started;
    console.log(`✓ ${name} (${ms} ms) ${note}`);
    rows.push([name, '✓', `${note} (${ms} ms)`]);
  } catch (error) {
    const message = error instanceof CheckFailed ? error.message : String(error?.stack ?? error);
    console.error(`✗ ${name}: ${message}`);
    rows.push([name, '✗', message]);
    failed = true;
    break;
  }
}

if (process.env.GITHUB_STEP_SUMMARY) {
  const table = rows.map(([n, r, d]) => `| ${n} | ${r} | ${d.replaceAll('|', '\\|')} |`).join('\n');
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### Smoke test: ${base}\n\n| check | result | detail |\n|---|---|---|\n${table}\n\n`,
  );
}
process.exit(failed ? 1 : 0);
