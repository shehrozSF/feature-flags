// Tests for the JavaScript that runs inside n8n (ADR 0040). Each code/*.js file is
// run the way n8n runs a Code node: as a function body with $input and $env in scope.
// Inputs are real: events built and signed by the API's own code, and the sandbox's
// seed flags; the summary logic is checked against eval-core with properties.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { describeRollout } from '../../packages/eval-core/src/rollout';
import { arbFlag } from '../../packages/eval-core/test/arbitraries';
import { SEED_FLAGS } from '../../apps/api/src/domain/sandboxes';
import { buildFlagEvent } from '../../apps/api/src/webhooks/events';
import { signatureHeader } from '../../apps/api/src/webhooks/dispatcher';
import { WORKFLOWS } from './workflows.mjs';

const here = import.meta.dirname;
const source = (file) => readFileSync(join(here, 'code', file), 'utf8');
const require = createRequire(import.meta.url);

/**
 * Runs a Code node file. Without $input it returns the named functions (the file's
 * n8n entry is skipped); with $input it returns what n8n would get: the items.
 */
function load(file, names, scope = {}) {
  const body = `${source(file)}\n;return { ${names.join(', ')} };`;
  return new Function('require', '$input', '$env', '$getWorkflowStaticData', '$', body)(
    require,
    scope.$input,
    scope.$env,
    scope.$getWorkflowStaticData,
    scope.$,
  );
}
const input = (json) => ({ first: () => ({ json }) });

const PROJECT = '3f2a6c1e-8b4d-4e7a-9c2f-1a2b3c4d5e6f';
const SECRET = `whsec_${'s'.repeat(43)}`;
const NOW = 1_763_000_000;

const flag = (overrides = {}) => ({
  ...SEED_FLAGS.find((f) => f.key === 'new-pricing'),
  salt: 's',
  version: 3,
  updatedAt: '2026-11-12T10:00:00.000Z',
  ...overrides,
});

/** What n8n's Webhook node hands the Code node: lower-case headers and the parsed body. */
async function delivery(event, { secret = SECRET, now = NOW } = {}) {
  const raw = JSON.stringify(event);
  const headers = { 'x-ff-signature': await signatureHeader(secret, raw, now * 1000) };
  return { headers, body: JSON.parse(raw) };
}

describe('flag-change.js: verify', () => {
  const { verify } = load('flag-change.js', ['verify', 'format']);
  const updated = buildFlagEvent({
    type: 'flag.updated',
    projectId: PROJECT,
    before: flag(),
    after: flag({ enabled: false, version: 4 }),
    source: 'mcp',
  });

  it('accepts an event signed by the API', async () => {
    const { headers, body } = await delivery(updated);
    expect(verify(headers, body, SECRET, NOW)).toBeNull();
  });

  it.each([
    [
      'a changed body',
      async (d) => ({ ...d, body: { ...d.body, summary: 'forged' } }),
      'signature does not match',
    ],
    [
      'another secret',
      async () => delivery(updated, { secret: `whsec_${'x'.repeat(43)}` }),
      'signature does not match',
    ],
    ['no signature', async (d) => ({ ...d, headers: {} }), 'missing or malformed x-ff-signature'],
    [
      'a malformed one',
      async (d) => ({ ...d, headers: { 'x-ff-signature': 'v1=abc' } }),
      'missing or malformed x-ff-signature',
    ],
    [
      'a signature 5 min + 1 s old',
      async () => delivery(updated, { now: NOW - 301 }),
      'signature timestamp is too far off',
    ],
    [
      'one 5 min + 1 s in the future',
      async () => delivery(updated, { now: NOW + 301 }),
      'signature timestamp is too far off',
    ],
  ])('refuses %s', async (_, make, reason) => {
    const d = await make(await delivery(updated));
    expect(verify(d.headers, d.body, SECRET, NOW)).toBe(reason);
  });

  it('accepts exactly 5 minutes of clock difference', async () => {
    const { headers, body } = await delivery(updated, { now: NOW - 300 });
    expect(verify(headers, body, SECRET, NOW)).toBeNull();
  });

  it('property: any flag content survives n8n parsing, so the signature still matches', async () => {
    // The receiver rebuilds the signed bytes with JSON.stringify(parsed body). That
    // is only sound if stringify(parse(s)) === s for whatever the API sends, including
    // odd variant values (integer-like keys, unicode, nesting).
    await fc.assert(
      fc.asyncProperty(fc.array(fc.jsonValue(), { minLength: 1, maxLength: 3 }), async (values) => {
        const variants = values.map((value, i) => ({ key: `v${i}`, value }));
        const after = flag({
          variants,
          offVariant: 'v0',
          rules: [],
          defaultServe: { variant: 'v0' },
        });
        const event = buildFlagEvent({
          type: 'flag.created',
          projectId: PROJECT,
          after,
          source: 'api',
        });
        const raw = JSON.stringify(event);
        expect(JSON.stringify(JSON.parse(raw))).toBe(raw);
        const { headers, body } = await delivery(event);
        expect(verify(headers, body, SECRET, NOW)).toBeNull();
      }),
      { numRuns: 100 },
    );
  });
});

describe('flag-change.js: format', () => {
  const { format } = load('flag-change.js', ['verify', 'format']);
  const base = (overrides) => ({ type: 'flag.updated', source: 'api', summary: 'x', ...overrides });

  it.each([
    ['flag.created', '🆕'],
    ['flag.updated', '🔁'],
    ['flag.archived', '🗄️'],
    ['ping', '🏓'],
  ])('%s starts with %s and the event summary', (type, icon) => {
    expect(format(base({ type, summary: '"a" archived' }))).toBe(`${icon} "a" archived`);
  });

  it('says when the change came through MCP', () => {
    expect(format(base({ source: 'mcp' }))).toBe('🔁 x (via MCP)');
  });

  it("fits Discord's 2000-character limit", () => {
    const text = format(base({ summary: 'y'.repeat(5000) }));
    expect(text).toHaveLength(2000);
    expect(text.endsWith('…')).toBe(true);
  });
});

describe('flag-change.js as n8n runs it', () => {
  const event = buildFlagEvent({
    type: 'flag.updated',
    projectId: PROJECT,
    before: flag(),
    after: flag({
      defaultServe: {
        rollout: [
          { variant: 'on', weight: 2500 },
          { variant: 'off', weight: 7500 },
        ],
      },
      version: 4,
    }),
    source: 'mcp',
  });

  it('a signed event becomes one valid item with the Discord text', async () => {
    const now = Date.now();
    const raw = JSON.stringify(event);
    const headers = { 'x-ff-signature': await signatureHeader(SECRET, raw, now) };
    const items = load('flag-change.js', [], {
      $input: input({ headers, body: JSON.parse(raw) }),
      $env: { FF_WEBHOOK_SECRET: SECRET },
      $getWorkflowStaticData: () => ({}),
    });
    expect(items).toEqual([
      {
        json: {
          valid: true,
          eventId: event.id,
          duplicate: false,
          content:
            '🔁 "new-pricing": rule pro-plan: on 100% · everyone else: on 10%, off 90% → rule pro-plan: on 100% · everyone else: on 25%, off 75% (via MCP)',
        },
      },
    ]);
  });

  // Review M-2: an event already posted (a retry after a lost answer, or a replay
  // inside the 5-minute window) is accepted without posting it again.
  it('an event id already posted is marked duplicate', async () => {
    const items = load('flag-change.js', [], {
      $input: input(await delivery(event, { now: Math.floor(Date.now() / 1000) })),
      $env: { FF_WEBHOOK_SECRET: SECRET },
      $getWorkflowStaticData: () => ({ posted: ['other-id', event.id] }),
    });
    expect(items[0].json).toMatchObject({ valid: true, duplicate: true });
  });

  it('without FF_WEBHOOK_SECRET everything is refused', async () => {
    const items = load('flag-change.js', [], {
      $input: input(await delivery(event)),
      $env: {},
    });
    expect(items).toEqual([{ json: { valid: false, reason: 'FF_WEBHOOK_SECRET is not set' } }]);
  });
});

describe('remember-event.js', () => {
  const { remember } = load('remember-event.js', ['remember', 'KEEP']);

  it('adds the id once, newest last', () => {
    expect(remember(['a', 'b'], 'c')).toEqual(['a', 'b', 'c']);
    expect(remember(['a', 'b'], 'a')).toEqual(['b', 'a']);
  });

  it('keeps only the newest 200', () => {
    const many = Array.from({ length: 200 }, (_, i) => `id${i}`);
    const after = remember(many, 'new');
    expect(after).toHaveLength(200);
    expect(after[0]).toBe('id1');
    expect(after.at(-1)).toBe('new');
  });

  it("as n8n runs it: stores the id that 'Verify and format' passed on", () => {
    const store = { posted: ['x'] };
    const items = load('remember-event.js', [], {
      $input: input({}),
      $getWorkflowStaticData: () => store,
      $: (name) => ({ first: () => ({ json: { eventId: `${name}:evt-1` } }) }),
    });
    expect(store.posted).toEqual(['x', 'Verify and format:evt-1']);
    expect(items).toEqual([{ json: { remembered: 'Verify and format:evt-1' } }]);
  });
});

describe('daily-summary.js', () => {
  const lib = load('daily-summary.js', ['describe', 'activeRollouts', 'summarize']);
  const seeds = SEED_FLAGS.map((f) => ({ ...f, salt: 's', version: 1 }));

  it("the sandbox's seed flags: new-pricing and cta-color are mid-rollout", () => {
    expect(lib.summarize(seeds, '2026-11-12')).toBe(
      [
        '📊 **Rollouts in progress** (2026-11-12)',
        '• `cta-color`: everyone: blue 34%, green 33%, red 33%',
        '• `new-pricing`: rule pro-plan: on 100% · everyone else: on 10%, off 90%',
      ].join('\n'),
    );
  });

  it('a rollout at 100% / 0% is finished, not in progress', () => {
    // Random weights rarely land on exactly 10000/0, so this case is pinned by hand.
    const done = flag({
      rules: [],
      defaultServe: {
        rollout: [
          { variant: 'on', weight: 10000 },
          { variant: 'off', weight: 0 },
        ],
      },
    });
    expect(lib.activeRollouts([done])).toEqual([]);
  });

  it('nothing split: says so', () => {
    expect(lib.summarize([], '2026-11-12')).toBe('📊 Rollouts on 2026-11-12: none in progress.');
  });

  it('property: the same text as eval-core describeRollout for any flag that is on', () => {
    fc.assert(
      fc.property(arbFlag(), (f) => {
        const on = { ...f, enabled: true };
        expect(lib.describe(on)).toBe(describeRollout(on).text);
      }),
    );
  });

  it("property: a flag is listed exactly when eval-core says it's splitting", () => {
    fc.assert(
      fc.property(arbFlag(), (f) => {
        expect(lib.activeRollouts([f]).length === 1).toBe(describeRollout(f).splitting);
      }),
    );
  });

  it('as n8n runs it: one item with the content', () => {
    const items = load('daily-summary.js', [], { $input: input({ flags: [] }), $env: {} });
    expect(items).toEqual([{ json: { content: expect.stringContaining('none in progress') } }]);
  });
});

describe('workflows', () => {
  const committed = (file) => JSON.parse(readFileSync(join(here, 'workflows', file), 'utf8'));
  const codeOf = (workflow, name) => workflow.nodes.find((n) => n.name === name).parameters.jsCode;

  it('the committed JSON is what workflows.mjs builds (run it after editing code/*.js)', () => {
    for (const [file, workflow] of Object.entries(WORKFLOWS)) {
      expect(committed(file), file).toEqual(workflow);
    }
  });

  it('each Code node runs exactly the tested file', () => {
    expect(codeOf(committed('flag-change-to-discord.json'), 'Verify and format')).toBe(
      source('flag-change.js'),
    );
    expect(codeOf(committed('flag-change-to-discord.json'), 'Remember event')).toBe(
      source('remember-event.js'),
    );
    expect(codeOf(committed('daily-rollout-summary.json'), 'Summarize rollouts')).toBe(
      source('daily-summary.js'),
    );
  });

  it('every connection points at a node that exists', () => {
    for (const workflow of Object.values(WORKFLOWS)) {
      const names = new Set(workflow.nodes.map((n) => n.name));
      for (const [from, { main }] of Object.entries(workflow.connections)) {
        expect(names.has(from), from).toBe(true);
        for (const target of main.flat()) expect(names.has(target.node), target.node).toBe(true);
      }
    }
  });

  it('valid and new → Discord → remembered → 200; duplicate → 200 only; invalid → 401', () => {
    const { connections, nodes } = WORKFLOWS['flag-change-to-discord.json'];
    const next = (from, branch = 0) => connections[from].main[branch][0].node;
    expect(next('Signature valid?', 0)).toBe('Already posted?');
    expect(next('Signature valid?', 1)).toBe('Refused');
    expect(next('Already posted?', 0)).toBe('Accepted');
    expect(next('Already posted?', 1)).toBe('Post to Discord');
    // Remembered only after Discord took it, so a failed post is retried, not lost.
    expect(next('Post to Discord')).toBe('Remember event');
    expect(next('Remember event')).toBe('Accepted');
    const refused = nodes.find((n) => n.name === 'Refused');
    expect(refused.parameters.options.responseCode).toBe(401);
  });

  it('Discord posts never ping anyone (review M-5: a variant key "@everyone")', () => {
    for (const workflow of Object.values(WORKFLOWS)) {
      const post = workflow.nodes.find((n) => n.name === 'Post to Discord');
      expect(post.parameters.jsonBody).toContain('allowed_mentions: { parse: [] }');
    }
  });

  it('no secret is written into a workflow: everything comes from the environment', () => {
    const text = JSON.stringify(WORKFLOWS);
    expect(text).not.toMatch(/whsec_|ff_admin_|discord\.com\/api\/webhooks/);
    expect(text).toContain('$env.DISCORD_WEBHOOK_URL');
    expect(text).toContain('$env.FF_ADMIN_KEY');
  });
});

// Review I-1: the tunnel must expose the signed webhook path, not n8n's editor or API.
describe('only the webhook is public', () => {
  const compose = readFileSync(join(here, 'docker-compose.yml'), 'utf8');
  const policy = readFileSync(join(here, 'ngrok-policy.yml'), 'utf8');

  it('the editor port is bound to this machine only, not the network', () => {
    expect(compose).toContain("'127.0.0.1:5678:5678'");
    expect(compose).not.toMatch(/- '5678:5678'/);
  });

  it('ngrok runs with the traffic policy', () => {
    expect(compose).toMatch(/--traffic-policy-file \/etc\/ngrok\/policy\.yml/);
    expect(compose).toContain('./ngrok-policy.yml:/etc/ngrok/policy.yml:ro');
  });

  it('the policy denies every request except POST /webhook/ff-flag-change', () => {
    expect(policy).toContain(
      "!(req.method == 'POST' && req.url.path == '/webhook/ff-flag-change')",
    );
    expect(policy).toMatch(/type: deny/);
  });
});
