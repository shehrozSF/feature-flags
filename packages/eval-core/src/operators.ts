import type { Condition, Context } from './types';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseSemver(s: string): [number, number, number] | null {
  const m = SEMVER.exec(s);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function semverGte(a: string, b: string): boolean {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    if (pa[i]! !== pb[i]!) return pa[i]! > pb[i]!;
  }
  return true;
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Whether one targeting condition holds for a context (spec §5.3). Missing
 * attributes and type mismatches are false, never errors. Only own properties
 * count, so `toString` or `constructor` can't match through the prototype.
 */
export function matchCondition(condition: Condition, context: Context): boolean {
  // Rules arrive off the network, so guard the shape rather than trust the types.
  if (typeof condition !== 'object' || condition === null) return false;
  if (typeof context !== 'object' || context === null) return false;
  const { attribute, op, values } = condition;
  if (!Array.isArray(values) || !Object.hasOwn(context, attribute)) return false;
  const attr = context[attribute];
  const target = values[0];
  if (attr === undefined || target === undefined) return false;

  switch (op) {
    case 'eq':
      return attr === target;
    case 'in':
      return values.some((v) => v === attr);
    case 'contains':
      return typeof attr === 'string' && typeof target === 'string' && attr.includes(target);
    case 'gt':
      return isFiniteNumber(attr) && isFiniteNumber(target) && attr > target;
    case 'lt':
      return isFiniteNumber(attr) && isFiniteNumber(target) && attr < target;
    case 'semverGte':
      return typeof attr === 'string' && typeof target === 'string' && semverGte(attr, target);
    default:
      return false;
  }
}
