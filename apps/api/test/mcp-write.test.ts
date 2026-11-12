import { LIMITS, type FlagResource } from '@ff/contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FlagService } from '../src/domain/flags';
import { PostgresKeyVerifier, PostgresRulesetSource } from '../src/domain/postgres-sources';
import { SandboxService } from '../src/domain/sandboxes';
import { createApp, type AppDeps } from '../src/http/app';
import { PostgresRepository } from '../src/repo/postgres';
import { createTestDatabase } from './helpers/db';
import { callTool, MCP_HEADERS, mcpRequest } from './helpers/mcp';

// The write path end to end (ADR 0038): propose changes nothing and returns a
// token; apply does exactly what was proposed, once, by the same project, within
// 5 minutes, and only if nobody changed the flag in between.
const SECRET = 'mcp-write-test-secret-long-enough-0123456789';

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let deps: AppDeps;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  db = await createTestDatabase();
  const repo = new PostgresRepository(db.pool);
  deps = {
    flags: new FlagService(repo),
    sandboxes: new SandboxService(repo),
    rulesets: new PostgresRulesetSource(repo),
    keys: new PostgresKeyVerifier(repo),
    version: 'test',
    mcpConfirmSecret: SECRET,
  };
  app = createApp(deps);
});
afterAll(() => db.drop());
afterEach(() => vi.useRealTimers());

async function sandbox(): Promise<string> {
  const res = await app.request('/v1/sandboxes', { method: 'POST' });
  return ((await res.json()) as { keys: { admin: string } }).keys.admin;
}

const auth = (admin: string) => ({ authorization: `Bearer ${admin}` });

async function createFlag(admin: string, overrides: Record<string, unknown> = {}) {
  const res = await app.request('/v1/flags', {
    method: 'POST',
    headers: { ...auth(admin), 'content-type': 'application/json' },
    body: JSON.stringify({
      key: 'checkout-v2',
      name: 'Checkout v2',
      enabled: true,
      variants: [
        { key: 'on', value: true },
        { key: 'off', value: false },
      ],
      offVariant: 'off',
      defaultServe: {
        rollout: [
          { variant: 'on', weight: 1000 },
          { variant: 'off', weight: 9000 },
        ],
      },
      ...overrides,
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as FlagResource;
}

async function getFlag(admin: string, key = 'checkout-v2') {
  const res = await app.request(`/v1/flags/${key}`, { headers: auth(admin) });
  return { status: res.status, flag: res.ok ? ((await res.json()) as FlagResource) : null };
}

type Proposal = { summary: string; confirmToken: string; basedOnVersion: number };

async function propose(admin: string, change: Record<string, unknown>, key = 'checkout-v2') {
  const outcome = await callTool(app, admin, 'propose_flag_change', { key, change });
  expect(outcome.isError, outcome.text).toBe(false);
  return outcome.data as Proposal;
}

const toQuarter = { type: 'set_rollout', weights: { on: 25, off: 75 } };

describe('the happy path', () => {
  it('propose changes nothing; apply makes exactly the previewed change', async () => {
    const admin = await sandbox();
    const created = await createFlag(admin);

    const proposal = await propose(admin, toQuarter);
    expect(proposal.summary).toBe(
      'Change "checkout-v2": everyone: on 10%, off 90% → everyone: on 25%, off 75%',
    );
    expect(proposal.basedOnVersion).toBe(created.version);
    // Nothing written yet: same version, same weights.
    expect((await getFlag(admin)).flag).toMatchObject({
      version: created.version,
      defaultServe: created.defaultServe,
    });

    const applied = await callTool(app, admin, 'apply_flag_change', {
      key: 'checkout-v2',
      confirmToken: proposal.confirmToken,
    });
    expect(applied.isError, applied.text).toBe(false);
    expect(applied.data).toMatchObject({
      applied: true,
      summary: '"checkout-v2" now: everyone: on 25%, off 75%',
      propagation: 'live',
    });
    const after = (await getFlag(admin)).flag!;
    expect(after.version).toBeGreaterThan(created.version);
    expect(after.defaultServe).toEqual({
      rollout: [
        { variant: 'on', weight: 2500 },
        { variant: 'off', weight: 7500 },
      ],
    });
  });

  it('turns a flag off', async () => {
    const admin = await sandbox();
    await createFlag(admin);
    const proposal = await propose(admin, { type: 'set_enabled', enabled: false });
    await callTool(app, admin, 'apply_flag_change', {
      key: 'checkout-v2',
      confirmToken: proposal.confirmToken,
    });
    expect((await getFlag(admin)).flag!.enabled).toBe(false);
  });

  it('archives a flag', async () => {
    const admin = await sandbox();
    await createFlag(admin);
    const proposal = await propose(admin, { type: 'archive' });
    const applied = await callTool(app, admin, 'apply_flag_change', {
      key: 'checkout-v2',
      confirmToken: proposal.confirmToken,
    });
    expect(applied.data).toMatchObject({ applied: true, summary: 'Archived "checkout-v2".' });
    expect((await getFlag(admin)).status).toBe(404);
  });
});

describe('review fixes', () => {
  // Review #1 + #8: a rule change carries every rule in the token, so a flag near
  // the 32 KB rules limit makes a token of ~40 KB. It must still be appliable,
  // and a rule rollout must survive the GET → token → PATCH round trip.
  it('a rule rollout on a flag with rules near the size limit applies end to end', async () => {
    const admin = await sandbox();
    const values = Array.from({ length: 125 }, (_, j) => String(j).padStart(8, '0'));
    const rules = Array.from({ length: LIMITS.rulesPerFlag }, (_, r) => ({
      id: `r${r}`,
      conditions: [{ attribute: 'userId', op: 'in', values }],
      serve: { variant: 'off' },
    }));
    const size = JSON.stringify(rules).length;
    expect(size).toBeGreaterThan(28_000);
    expect(size).toBeLessThan(LIMITS.rulesJsonBytes);
    await createFlag(admin, { rules });

    const proposal = await propose(admin, {
      type: 'set_rollout',
      ruleId: 'r7',
      weights: { on: 30, off: 70 },
    });
    expect(proposal.confirmToken.length).toBeGreaterThan(30_000);
    const applied = await callTool(app, admin, 'apply_flag_change', {
      key: 'checkout-v2',
      confirmToken: proposal.confirmToken,
    });
    expect(applied.isError, applied.text).toBe(false);

    const after = (await getFlag(admin)).flag!;
    expect(after.rules[7]!.serve).toEqual({
      rollout: [
        { variant: 'on', weight: 3000 },
        { variant: 'off', weight: 7000 },
      ],
    });
    // Every other rule exactly as it was.
    expect(after.rules.filter((_, i) => i !== 7)).toEqual(rules.filter((_, i) => i !== 7));
  });

  // Review #2: the client's approval prompt for apply should name the flag, so a
  // person approving it can see what they approve; the token must agree.
  it('apply needs the flag key, and refuses a token made for another flag', async () => {
    const admin = await sandbox();
    await createFlag(admin);
    await createFlag(admin, { key: 'other-flag' });
    const { confirmToken } = await propose(admin, toQuarter);

    const wrongKey = await callTool(app, admin, 'apply_flag_change', {
      key: 'other-flag',
      confirmToken,
    });
    expect(wrongKey.isError).toBe(true);
    expect(wrongKey.text).toBe(
      'Not applied: that confirm token is for "checkout-v2", not "other-flag"',
    );
    const noKey = await callTool(app, admin, 'apply_flag_change', { confirmToken });
    expect(noKey.isError).toBe(true); // rejected by the input schema: key is required
    // Neither flag changed.
    expect((await getFlag(admin)).flag!.defaultServe).toMatchObject({
      rollout: [{ variant: 'on', weight: 1000 }, expect.anything()],
    });
  });
});

describe('apply reports propagation', () => {
  it('a saved change whose push to live SDKs was delayed says so', async () => {
    // As in the HTTP API: the write stands, the hub catches up later (spec §9.1).
    const delayedApp = createApp({ ...deps, notify: () => Promise.resolve('delayed' as const) });
    const admin = await sandbox();
    await createFlag(admin);
    const proposal = await propose(admin, toQuarter);
    const applied = await callTool(delayedApp, admin, 'apply_flag_change', {
      key: 'checkout-v2',
      confirmToken: proposal.confirmToken,
    });
    expect(applied.data).toMatchObject({
      applied: true,
      propagation: 'saved, but live SDKs will only see it on their next refresh',
    });
  });
});

describe('apply refuses', () => {
  it('the same token twice: the version it carries has moved on', async () => {
    const admin = await sandbox();
    await createFlag(admin);
    const { confirmToken } = await propose(admin, toQuarter);
    await callTool(app, admin, 'apply_flag_change', { key: 'checkout-v2', confirmToken });
    const versionAfterFirst = (await getFlag(admin)).flag!.version;

    const again = await callTool(app, admin, 'apply_flag_change', {
      key: 'checkout-v2',
      confirmToken,
    });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/^Not applied: "checkout-v2" changed since the preview/);
    expect((await getFlag(admin)).flag!.version).toBe(versionAfterFirst);
  });

  it('a stale preview: someone changed the flag after it, and their change survives', async () => {
    const admin = await sandbox();
    const created = await createFlag(admin);
    const { confirmToken } = await propose(admin, toQuarter);

    // Meanwhile, someone turns it off in the dashboard.
    const patched = await app.request('/v1/flags/checkout-v2', {
      method: 'PATCH',
      headers: {
        ...auth(admin),
        'content-type': 'application/json',
        'if-match': `"${created.version}"`,
      },
      body: JSON.stringify({ enabled: false }),
    });
    expect(patched.status).toBe(200);

    const outcome = await callTool(app, admin, 'apply_flag_change', {
      key: 'checkout-v2',
      confirmToken,
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain(`it was version ${created.version}, now ${created.version + 1}`);
    const now = (await getFlag(admin)).flag!;
    expect(now.enabled).toBe(false); // their change
    expect(now.defaultServe).toEqual(created.defaultServe); // not ours
  });

  it("another project's token, even with a flag of the same key", async () => {
    const a = await sandbox();
    const b = await sandbox();
    await createFlag(a);
    await createFlag(b);
    const { confirmToken } = await propose(a, toQuarter);

    const outcome = await callTool(app, b, 'apply_flag_change', {
      key: 'checkout-v2',
      confirmToken,
    });
    expect(outcome).toMatchObject({ isError: true });
    expect(outcome.text).toBe('Not applied: that confirm token was made for another project');
    expect((await getFlag(b)).flag!.defaultServe).toMatchObject({
      rollout: [{ variant: 'on', weight: 1000 }, expect.anything()],
    });
  });

  it('an expired token (5 minutes)', async () => {
    const admin = await sandbox();
    await createFlag(admin);
    const { confirmToken } = await propose(admin, toQuarter);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);

    const outcome = await callTool(app, admin, 'apply_flag_change', {
      key: 'checkout-v2',
      confirmToken,
    });
    expect(outcome.text).toBe(
      'Not applied: that confirm token has expired (they last 5 minutes): propose the change again',
    );
    expect((await getFlag(admin)).flag!.defaultServe).toMatchObject({
      rollout: [{ variant: 'on', weight: 1000 }, expect.anything()],
    });
  });

  it('a made-up token', async () => {
    const admin = await sandbox();
    await createFlag(admin);
    const outcome = await callTool(app, admin, 'apply_flag_change', {
      key: 'checkout-v2',
      confirmToken: 'v1.abc.def',
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(/^Not applied: that confirm token is invalid/);
  });
});

describe('propose refuses', () => {
  it('a missing flag: the API 404 as a tool error', async () => {
    const admin = await sandbox();
    const outcome = await callTool(app, admin, 'propose_flag_change', {
      key: 'nope',
      change: { type: 'archive' },
    });
    expect(outcome).toMatchObject({ isError: true });
    expect(outcome.text).toMatch(/^API error 404/);
  });

  it('an invalid change, with the reason and no token', async () => {
    const admin = await sandbox();
    await createFlag(admin);
    const outcome = await callTool(app, admin, 'propose_flag_change', {
      key: 'checkout-v2',
      change: { type: 'set_rollout', weights: { on: 30, off: 30 } },
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toBe("Can't propose that: percentages must add up to 100, got 60");
    expect(outcome.text).not.toContain('confirmToken');
  });

  it('a change type that does not exist is rejected by the input schema', async () => {
    const admin = await sandbox();
    await createFlag(admin);
    const outcome = await callTool(app, admin, 'propose_flag_change', {
      key: 'checkout-v2',
      change: { type: 'delete_everything' },
    });
    expect(outcome.isError).toBe(true);
  });
});

describe('which tools exist', () => {
  const toolsOf = async (target: ReturnType<typeof createApp>, admin: string, query = '') => {
    const res = await target.request(`/mcp${query}`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, ...auth(admin) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const { result } = (await res.json()) as {
      result: { tools: { name: string; annotations: Record<string, boolean> }[] };
    };
    return Object.fromEntries(result.tools.map((t) => [t.name, t.annotations]));
  };

  it('with a secret: all four; only apply is marked as changing things', async () => {
    const tools = await toolsOf(app, await sandbox());
    expect(Object.keys(tools)).toEqual([
      'list_flags',
      'get_flag',
      'propose_flag_change',
      'apply_flag_change',
    ]);
    expect(tools.propose_flag_change).toMatchObject({ readOnlyHint: true });
    expect(tools.apply_flag_change).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it('?mode=read: only the read tools, and apply cannot be called', async () => {
    const admin = await sandbox();
    await createFlag(admin);
    expect(Object.keys(await toolsOf(app, admin, '?mode=read'))).toEqual([
      'list_flags',
      'get_flag',
    ]);

    // Even with a valid token from a normal connection, apply doesn't exist here.
    const { confirmToken } = await propose(admin, toQuarter);
    const res = await app.request('/mcp?mode=read', {
      method: 'POST',
      headers: { ...MCP_HEADERS, ...auth(admin) },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'apply_flag_change', arguments: { key: 'checkout-v2', confirmToken } },
      }),
    });
    const body = JSON.stringify(await res.json());
    expect(body).toContain('apply_flag_change not found');
    expect((await getFlag(admin)).flag!.defaultServe).toMatchObject({
      rollout: [{ variant: 'on', weight: 1000 }, expect.anything()],
    });
  });

  it('?mode=readonly (a typo) is a 400, not a quiet fallback to read and write', async () => {
    const res = await mcpRequest(app, await sandbox(), 'tools/list');
    expect(res.status).toBe(200);
    const typo = await app.request('/mcp?mode=readonly', {
      method: 'POST',
      headers: { ...MCP_HEADERS, ...auth(await sandbox()) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(typo.status).toBe(400);
  });

  it('without a secret: read tools only, and the instructions say so', async () => {
    const { mcpConfirmSecret: _, ...withoutSecret } = deps;
    const readOnlyApp = createApp(withoutSecret);
    const admin = await sandbox();
    expect(Object.keys(await toolsOf(readOnlyApp, admin))).toEqual(['list_flags', 'get_flag']);
    const init = await mcpRequest(readOnlyApp, admin, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    expect(JSON.stringify(await init.json())).toContain('This connection is read-only');
  });

  it('with a secret, the instructions tell the model to confirm before applying', async () => {
    const init = await mcpRequest(app, await sandbox(), 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    const { result } = (await init.json()) as { result: { instructions: string } };
    expect(result.instructions).toContain('only call apply_flag_change after they confirm');
  });

  it('a short secret stops the app at startup', () => {
    expect(() => createApp({ ...deps, mcpConfirmSecret: 'short' })).toThrow(
      'MCP_CONFIRM_SECRET must be at least 32 characters',
    );
  });
});
