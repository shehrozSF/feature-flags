import { validateFlagShape, type FlagResource } from '@ff/contracts';
import { describe, expect, it } from 'vitest';
import { SEED_FLAGS } from '../../api/src/domain/sandboxes';
import { emptyDraft, problems, toDraft, toInput, toPatch, type Draft } from '../src/draft';

// The editor works on a "draft": what the form shows (text, percentages) rather
// than what the API stores (JSON values, basis points). These pure functions
// convert between the two, so they are tested without rendering anything.
const seeded: FlagResource[] = SEED_FLAGS.map((f, i) => ({
  ...f,
  salt: `salt-${i}`,
  version: 3,
  updatedAt: '2026-11-11T10:00:00.000Z',
}));

describe('draft ↔ flag', () => {
  it('round-trips every seeded flag', () => {
    for (const flag of seeded) {
      const { name, description, enabled, variants, offVariant, rules, defaultServe } = flag;
      expect(toPatch(toDraft(flag)), flag.key).toEqual({
        name,
        description,
        enabled,
        variants,
        offVariant,
        rules,
        defaultServe,
      });
      expect(problems(toDraft(flag)), flag.key).toEqual([]);
    }
  });

  it('percent ↔ basis points without drift', () => {
    const draft = toDraft(seeded.find((f) => f.key === 'cta-color')!);
    expect(draft.defaultServe).toMatchObject({ mode: 'rollout' });
    const rollout = draft.defaultServe.mode === 'rollout' ? draft.defaultServe : null;
    rollout!.weights = { blue: '33.3', green: '33.3', red: '33.4' };

    const patch = toPatch(draft);
    expect(patch.defaultServe).toEqual({
      rollout: [
        { variant: 'blue', weight: 3330 },
        { variant: 'green', weight: 3330 },
        { variant: 'red', weight: 3340 },
      ],
    });
    // and back: 3330 → "33.3", not "33.300000000000004"
    expect(toDraft({ ...seeded[1]!, defaultServe: patch.defaultServe }).defaultServe).toMatchObject(
      {
        weights: { blue: '33.3', green: '33.3', red: '33.4' },
      },
    );
  });

  it('condition values keep their types: numbers for gt and lt, text otherwise', () => {
    const draft: Draft = {
      ...toDraft(seeded[0]!),
      rules: [
        {
          id: 'r1',
          conditions: [
            { attribute: 'age', op: 'gt', values: '18' },
            { attribute: 'country', op: 'in', values: 'PK, IN ,  BD' },
          ],
          serve: { mode: 'variant', variant: 'on' },
        },
      ],
    };
    expect(toPatch(draft).rules).toEqual([
      {
        id: 'r1',
        conditions: [
          { attribute: 'age', op: 'gt', values: [18] },
          { attribute: 'country', op: 'in', values: ['PK', 'IN', 'BD'] },
        ],
        serve: { variant: 'on' },
      },
    ]);
  });
});

describe('problems()', () => {
  it('reports weights that do not add up to 100%', () => {
    const draft = toDraft(seeded.find((f) => f.key === 'cta-color')!);
    if (draft.defaultServe.mode === 'rollout') draft.defaultServe.weights.red = '10';
    expect(problems(draft)).toContainEqual({
      path: 'defaultServe.rollout',
      message: 'weights add up to 77%, they must add up to 100%', // seeded 34 + 33, red now 10
    });
  });

  it('reports text that is not JSON, or not a number', () => {
    const draft = toDraft(seeded[0]!);
    draft.variants[0]!.value = 'yes please';
    draft.rules = [
      {
        id: 'r1',
        conditions: [{ attribute: 'age', op: 'gt', values: 'eighteen' }],
        serve: { mode: 'variant', variant: 'on' },
      },
    ];
    const paths = problems(draft).map((p) => p.path);
    expect(paths).toContain('variants.0.value');
    expect(paths).toContain('rules.0.conditions.0.values');
  });

  it('includes every error the API would report for the same flag', () => {
    const broken: Draft[] = [
      { ...toDraft(seeded[0]!), offVariant: 'nope' },
      { ...toDraft(seeded[0]!), name: '' },
      {
        ...toDraft(seeded[0]!),
        variants: [
          { key: 'on', value: 'true' },
          { key: 'on', value: 'false' },
        ],
      },
    ];
    for (const draft of broken) {
      const found = problems(draft).map((p) => p.path);
      for (const e of validateFlagShape(toInput(draft))) expect(found).toContain(e.path);
      expect(found.length).toBeGreaterThan(0);
    }
  });

  it('a new flag needs a valid key', () => {
    const draft = { ...emptyDraft(), key: 'Not Valid' };
    expect(problems(draft, { isNew: true }).map((p) => p.path)).toContain('key');
  });
});
