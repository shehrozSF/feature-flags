import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FlagService } from '../src/domain/flags';
import { PostgresKeyVerifier, PostgresRulesetSource } from '../src/domain/postgres-sources';
import { SandboxService } from '../src/domain/sandboxes';
import { createApp } from '../src/http/app';
import { PostgresRepository } from '../src/repo/postgres';
import { createTestDatabase } from './helpers/db';
import { callTool, mcpRequest } from './helpers/mcp';

// The MCP tools on the real app and a real database. Tools call the API
// in-process, so this also proves that hop works: the caller's key reaches the
// inner request, and API errors come back as tool errors.
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  db = await createTestDatabase();
  const repo = new PostgresRepository(db.pool);
  app = createApp({
    flags: new FlagService(repo),
    sandboxes: new SandboxService(repo),
    rulesets: new PostgresRulesetSource(repo),
    keys: new PostgresKeyVerifier(repo),
    version: 'test',
  });
});
afterAll(() => db.drop());

type Keys = { admin: string; server: string; client: string };

async function sandbox(): Promise<Keys> {
  const res = await app.request('/v1/sandboxes', { method: 'POST' });
  expect(res.status).toBe(201);
  return ((await res.json()) as { keys: Keys }).keys;
}

async function createFlag(adminKey: string, flag: Record<string, unknown>) {
  const res = await app.request('/v1/flags', {
    method: 'POST',
    headers: { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      name: String(flag.key),
      variants: [
        { key: 'on', value: true },
        { key: 'off', value: false },
      ],
      offVariant: 'off',
      defaultServe: { variant: 'on' },
      enabled: true, // the API creates flags off unless told otherwise
      ...flag,
    }),
  });
  expect(res.status).toBe(201);
}

const quarter = {
  rollout: [
    { variant: 'on', weight: 2500 },
    { variant: 'off', weight: 7500 },
  ],
};

describe('tools/list', () => {
  it('lists the read tools, marked read-only', async () => {
    const { admin } = await sandbox();
    const res = await mcpRequest(app, admin, 'tools/list');
    const { result } = (await res.json()) as {
      result: { tools: { name: string; annotations: Record<string, unknown> }[] };
    };
    const byName = Object.fromEntries(result.tools.map((t) => [t.name, t]));
    for (const name of ['list_flags', 'get_flag']) {
      expect(byName[name]?.annotations).toMatchObject({ readOnlyHint: true });
    }
  });
});

describe('the in-process hop', () => {
  it('inner API requests log under the MCP request id, so one tool call reads as one story', async () => {
    const { admin } = await sandbox();
    const ray = '8f2b3c4d5e6f7a8b-LHR';
    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await mcpRequest(
      app,
      admin,
      'tools/call',
      { name: 'list_flags', arguments: {} },
      { 'cf-ray': ray },
    );
    // Read the calls before mockRestore(), which also wipes them.
    const lines = info.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    info.mockRestore();
    const requests = lines.filter((l) => l.event === 'request');
    expect(requests.map((l) => [l.route, l.requestId])).toEqual([
      ['/v1/flags', ray], // the tool's inner call, logged first because it finishes first
      ['/mcp', ray],
    ]);
  });
});

describe('list_flags', () => {
  it('lists exactly the flags the API lists (a new sandbox has its demo flags)', async () => {
    const { admin } = await sandbox();
    const api = await app.request('/v1/flags', { headers: { authorization: `Bearer ${admin}` } });
    const apiKeys = ((await api.json()) as { flags: { key: string }[] }).flags.map((f) => f.key);
    expect(apiKeys.length).toBeGreaterThan(0);

    const { isError, data } = await callTool(app, admin, 'list_flags');
    expect(isError).toBe(false);
    expect((data as { flags: { key: string }[] }).flags.map((f) => f.key)).toEqual(apiKeys);
  });

  it('shows each flag with its rollout in percentages', async () => {
    const { admin } = await sandbox();
    await createFlag(admin, { key: 'checkout-v2', name: 'Checkout v2', defaultServe: quarter });
    await createFlag(admin, { key: 'dark-mode', enabled: false });

    const { data } = await callTool(app, admin, 'list_flags');
    const flags = (data as { flags: Record<string, unknown>[] }).flags;
    expect(flags).toEqual(
      expect.arrayContaining([
        {
          key: 'checkout-v2',
          name: 'Checkout v2',
          enabled: true,
          version: expect.any(Number) as number,
          rollout: 'everyone: on 25%, off 75%',
          splitting: true,
        },
        expect.objectContaining({
          key: 'dark-mode',
          enabled: false,
          rollout: 'off: everyone gets off',
          splitting: false,
        }),
      ]),
    );
  });

  it("only sees the caller's project: the inner call carries the caller's key", async () => {
    const a = await sandbox();
    const b = await sandbox();
    await createFlag(a.admin, { key: 'only-in-a' });
    const keysOf = async (admin: string) =>
      ((await callTool(app, admin, 'list_flags')).data as { flags: { key: string }[] }).flags.map(
        (f) => f.key,
      );
    expect(await keysOf(a.admin)).toContain('only-in-a');
    expect(await keysOf(b.admin)).not.toContain('only-in-a');
  });
});

describe('get_flag', () => {
  it('returns the flag in full plus per-rule percentages', async () => {
    const { admin } = await sandbox();
    await createFlag(admin, {
      key: 'checkout-v2',
      rules: [
        {
          id: 'pk',
          conditions: [{ attribute: 'country', op: 'eq', values: ['PK'] }],
          serve: { variant: 'on' },
        },
      ],
      defaultServe: quarter,
    });

    const { isError, data } = await callTool(app, admin, 'get_flag', { key: 'checkout-v2' });
    expect(isError).toBe(false);
    expect(data).toMatchObject({
      flag: { key: 'checkout-v2', defaultServe: quarter, version: expect.any(Number) as number },
      rollout: {
        rules: [{ ruleId: 'pk', shares: [{ variant: 'on', percent: 100 }] }],
        defaultShares: [
          { variant: 'on', percent: 25 },
          { variant: 'off', percent: 75 },
        ],
        text: 'rule pk: on 100% · everyone else: on 25%, off 75%',
      },
    });
  });

  it("a missing flag is a tool error with the API's reason, not a protocol error", async () => {
    const { admin } = await sandbox();
    const outcome = await callTool(app, admin, 'get_flag', { key: 'nope' });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(/^API error 404: /);
  });

  it("another project's flag is invisible (404), not leaked", async () => {
    const a = await sandbox();
    const b = await sandbox();
    await createFlag(a.admin, { key: 'secret-flag' });
    const outcome = await callTool(app, b.admin, 'get_flag', { key: 'secret-flag' });
    expect(outcome).toMatchObject({ isError: true });
    expect(outcome.text).toMatch(/^API error 404/);
  });

  it('a key with path characters stays one path segment', async () => {
    // "../flags" must not turn GET /v1/flags/<key> into a different route.
    const { admin } = await sandbox();
    const outcome = await callTool(app, admin, 'get_flag', { key: '../flags' });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(/^API error 404/);
  });

  it('a missing key argument is rejected by the input schema', async () => {
    const { admin } = await sandbox();
    const outcome = await callTool(app, admin, 'get_flag', {});
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('key');
  });
});
