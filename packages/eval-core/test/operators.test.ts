import { describe, expect, it } from 'vitest';
import { matchCondition } from '../src/operators';
import type { AttributeValue, Condition, Context, Operator } from '../src/types';

const check = (op: Operator, attr: AttributeValue | undefined, values: AttributeValue[]) =>
  matchCondition({ attribute: 'a', op, values }, attr === undefined ? {} : { a: attr });

describe('matchCondition', () => {
  it.each<{
    op: Operator;
    attr: AttributeValue | undefined;
    values: AttributeValue[];
    expected: boolean;
  }>([
    { op: 'eq', attr: 'PK', values: ['PK'], expected: true },
    { op: 'eq', attr: 'pk', values: ['PK'], expected: false },
    { op: 'eq', attr: 1, values: ['1'], expected: false },
    { op: 'eq', attr: true, values: [true], expected: true },
    { op: 'in', attr: 'PK', values: ['US', 'PK'], expected: true },
    { op: 'in', attr: 'GB', values: ['US', 'PK'], expected: false },
    { op: 'contains', attr: 'ali@acme.com', values: ['@acme.com'], expected: true },
    { op: 'contains', attr: 42, values: ['4'], expected: false },
    { op: 'gt', attr: 10, values: [5], expected: true },
    { op: 'gt', attr: 5, values: [5], expected: false },
    { op: 'gt', attr: '10', values: [5], expected: false },
    { op: 'gt', attr: NaN, values: [5], expected: false },
    { op: 'lt', attr: 3, values: [5], expected: true },
    { op: 'semverGte', attr: '1.10.0', values: ['1.9.0'], expected: true },
    { op: 'semverGte', attr: '1.2.3', values: ['1.2.3'], expected: true },
    { op: 'semverGte', attr: '1.2.2', values: ['1.2.3'], expected: false },
    { op: 'semverGte', attr: 'v1.2.3', values: ['1.0.0'], expected: false },
    { op: 'semverGte', attr: '1.2', values: ['1.0.0'], expected: false },
    { op: 'semverGte', attr: '1.2.3-beta', values: ['1.0.0'], expected: false },
    { op: 'semverGte', attr: '01.2.3', values: ['1.0.0'], expected: false },
    { op: 'eq', attr: undefined, values: ['x'], expected: false },
    { op: 'in', attr: undefined, values: ['x'], expected: false },
    { op: 'contains', attr: undefined, values: ['x'], expected: false },
    { op: 'gt', attr: undefined, values: [1], expected: false },
    { op: 'semverGte', attr: undefined, values: ['1.0.0'], expected: false },
    { op: 'eq', attr: 'x', values: [], expected: false },
  ])('$op($attr, $values) → $expected', ({ op, attr, values, expected }) => {
    expect(check(op, attr, values)).toBe(expected);
  });

  it('ignores inherited prototype properties', () => {
    expect(
      matchCondition({ attribute: 'toString', op: 'contains', values: ['function'] }, {}),
    ).toBe(false);
    expect(matchCondition({ attribute: 'constructor', op: 'eq', values: ['Object'] }, {})).toBe(
      false,
    );
  });

  it('ignores a __proto__ key unless the context really has one', () => {
    const cond: Condition = { attribute: '__proto__', op: 'eq', values: ['x'] };
    expect(matchCondition(cond, {})).toBe(false);
    expect(matchCondition(cond, JSON.parse('{"__proto__":"x"}') as Context)).toBe(true);
  });

  it('malformed conditions or contexts return false instead of throwing', () => {
    const cond = { attribute: 'a', op: 'eq', values: ['x'] } as Condition;
    const malformed: [unknown, unknown][] = [
      [{ ...cond, values: null }, { a: 'x' }],
      [{ attribute: 'a', op: 'eq' }, { a: 'x' }],
      [null, { a: 'x' }],
      [cond, null],
      [cond, 'not an object'],
    ];
    for (const [c, ctx] of malformed) {
      expect(matchCondition(c as Condition, ctx as Context)).toBe(false);
    }
  });

  it('unknown operator returns false', () => {
    const bad = { attribute: 'a', op: 'regex', values: ['.*'] } as unknown as Condition;
    expect(matchCondition(bad, { a: 'anything' })).toBe(false);
  });
});
