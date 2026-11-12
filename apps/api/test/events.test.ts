import { FlagEventSchema, type FlagResource } from '@ff/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildFlagEvent, diffFlags } from '../src/webhooks/events';
import { arbFlag } from '../../../packages/eval-core/test/arbitraries';

// Webhook events (ADR 0039): what changed, for machines (changes) and people (summary).
const PROJECT = '3f2a6c1e-8b4d-4e7a-9c2f-1a2b3c4d5e6f';
const NOW = Date.parse('2026-11-12T10:00:00Z');
const ID = '9e8d7c6b-5a49-4382-a1b0-c9d8e7f6a5b4';

const flag = (overrides: Partial<FlagResource> = {}): FlagResource => ({
  key: 'checkout-v2',
  name: 'Checkout v2',
  description: '',
  enabled: true,
  variants: [
    { key: 'on', value: true },
    { key: 'off', value: false },
  ],
  offVariant: 'off',
  rules: [],
  defaultServe: {
    rollout: [
      { variant: 'on', weight: 1000 },
      { variant: 'off', weight: 9000 },
    ],
  },
  salt: 's',
  version: 4,
  updatedAt: '2026-11-12T09:00:00.000Z',
  ...overrides,
});

const quarter = {
  rollout: [
    { variant: 'on', weight: 2500 },
    { variant: 'off', weight: 7500 },
  ],
};

describe('diffFlags', () => {
  it('a rollout change lists each weight that moved, with array indexes', () => {
    expect(diffFlags(flag(), flag({ defaultServe: quarter }))).toEqual([
      { path: 'defaultServe.rollout[0].weight', from: 1000, to: 2500 },
      { path: 'defaultServe.rollout[1].weight', from: 9000, to: 7500 },
    ]);
  });

  it('turning a flag off is one change', () => {
    expect(diffFlags(flag(), flag({ enabled: false }))).toEqual([
      { path: 'enabled', from: true, to: false },
    ]);
  });

  it('ignores what every write changes (version, updatedAt) and what never matters (salt)', () => {
    const later = flag({ version: 5, updatedAt: '2026-11-12T10:00:00.000Z', salt: 'other' });
    expect(diffFlags(flag(), later)).toEqual([]);
  });

  it('something added has only "to"; something removed only "from"', () => {
    const rule = { id: 'pk', conditions: [], serve: { variant: 'on' } };
    expect(diffFlags(flag(), flag({ rules: [rule] }))).toEqual([{ path: 'rules[0]', to: rule }]);
    expect(diffFlags(flag({ rules: [rule] }), flag())).toEqual([{ path: 'rules[0]', from: rule }]);
  });

  it('a serve switching shape shows both sides', () => {
    expect(diffFlags(flag(), flag({ defaultServe: { variant: 'on' } }))).toEqual([
      {
        path: 'defaultServe.rollout',
        from: [
          { variant: 'on', weight: 1000 },
          { variant: 'off', weight: 9000 },
        ],
      },
      { path: 'defaultServe.variant', to: 'on' },
    ]);
  });

  it("key order doesn't matter (Postgres JSONB reorders keys, issues #91)", () => {
    const reordered = flag({
      defaultServe: JSON.parse(
        '{"rollout":[{"weight":1000,"variant":"on"},{"weight":9000,"variant":"off"}]}',
      ) as FlagResource['defaultServe'],
    });
    expect(diffFlags(flag(), reordered)).toEqual([]);
  });

  it('NaN is equal to itself, so a flag holding it has no changes from itself (#95)', () => {
    // Found by the property below on a rare run: NaN !== NaN.
    const f = flag({
      rules: [
        {
          id: 'r',
          conditions: [{ attribute: 'age', op: 'gt', values: [Number.NaN] }],
          serve: { variant: 'on' },
        },
      ],
    });
    expect(diffFlags(f, f)).toEqual([]);
  });

  it('properties: a flag has no changes from itself, and any real change shows up', () => {
    fc.assert(
      fc.property(arbFlag(), arbFlag(), (a, b) => {
        expect(diffFlags(a, a)).toEqual([]);
        const strip = ({ version: _v, salt: _s, ...rest }: typeof a) => rest;
        const differs = JSON.stringify(strip(a)) !== JSON.stringify(strip(b));
        // Keys are generated in the same order, so JSON text equality is meaning here.
        expect(diffFlags(a, b).length > 0).toBe(differs);
      }),
    );
  });
});

describe('buildFlagEvent', () => {
  const at = { now: NOW, id: ID };

  it('flag.created: no before, the new flag after, a summary of what it serves', () => {
    const event = buildFlagEvent(
      { type: 'flag.created', projectId: PROJECT, after: flag(), source: 'api' },
      at,
    );
    expect(event).toEqual({
      id: ID,
      type: 'flag.created',
      projectId: PROJECT,
      key: 'checkout-v2',
      version: 4,
      occurredAt: '2026-11-12T10:00:00.000Z',
      source: 'api',
      summary: '"checkout-v2" created: everyone: on 10%, off 90%',
      before: null,
      after: flag(),
      changes: [],
    });
  });

  it('flag.updated: both sides, the changes, and before → after in words', () => {
    const after = flag({ defaultServe: quarter, version: 5 });
    const event = buildFlagEvent(
      { type: 'flag.updated', projectId: PROJECT, before: flag(), after, source: 'mcp' },
      at,
    );
    expect(event).toMatchObject({
      type: 'flag.updated',
      version: 5,
      source: 'mcp',
      summary: '"checkout-v2": everyone: on 10%, off 90% → everyone: on 25%, off 75%',
      before: flag(),
      after,
    });
    expect(event.changes).toHaveLength(2);
  });

  it('flag.updated that serves the same names the fields that changed', () => {
    const event = buildFlagEvent(
      {
        type: 'flag.updated',
        projectId: PROJECT,
        before: flag(),
        after: flag({ name: 'Checkout', description: 'new', version: 5 }),
        source: 'api',
      },
      at,
    );
    expect(event.summary).toBe('"checkout-v2" updated: description, name');
  });

  it('flag.archived: before only, with the archived version', () => {
    const event = buildFlagEvent(
      {
        type: 'flag.archived',
        projectId: PROJECT,
        before: flag(),
        after: flag({ version: 5 }),
        source: 'api',
      },
      at,
    );
    expect(event).toMatchObject({
      type: 'flag.archived',
      key: 'checkout-v2',
      version: 5,
      summary: '"checkout-v2" archived',
      before: flag(),
      after: null,
      changes: [],
    });
  });

  it('ping: no flag at all', () => {
    expect(buildFlagEvent({ type: 'ping', projectId: PROJECT }, at)).toEqual({
      id: ID,
      type: 'ping',
      projectId: PROJECT,
      key: null,
      version: null,
      occurredAt: '2026-11-12T10:00:00.000Z',
      source: 'api',
      summary: 'Test event from the feature flag API: this webhook works',
      before: null,
      after: null,
      changes: [],
    });
  });

  it('every event matches the published schema, with a fresh id each time by default', () => {
    const events = [
      buildFlagEvent({ type: 'ping', projectId: PROJECT }),
      buildFlagEvent({ type: 'flag.created', projectId: PROJECT, after: flag(), source: 'api' }),
      buildFlagEvent({
        type: 'flag.updated',
        projectId: PROJECT,
        before: flag(),
        after: flag({ enabled: false }),
        source: 'mcp',
      }),
      buildFlagEvent({
        type: 'flag.archived',
        projectId: PROJECT,
        before: flag(),
        after: flag(),
        source: 'api',
      }),
    ];
    for (const event of events) expect(FlagEventSchema.parse(event)).toEqual(event);
    expect(new Set(events.map((e) => e.id)).size).toBe(4);
  });
});
