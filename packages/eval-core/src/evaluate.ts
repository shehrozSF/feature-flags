import { bucketFor, pickRolloutVariant } from './bucket';
import { matchCondition } from './operators';
import type { Context, Flag, JsonValue, Result, Ruleset, Serve, Variant } from './types';

function resolveServe(flag: Flag, serve: Serve, context: Context): Variant | null {
  let key: string | null;
  if ('variant' in serve) {
    key = serve.variant;
  } else {
    const attribute = serve.bucketBy ?? 'userId';
    const value = Object.hasOwn(context, attribute) ? context[attribute] : undefined;
    key = pickRolloutVariant(serve.rollout, bucketFor(flag.salt, value));
  }
  return flag.variants.find((v) => v.key === key) ?? null;
}

/**
 * Decide a flag for a context (spec §5.2): off → first matching rule → default.
 * Never throws: anything unexpected returns the fallback with reason ERROR.
 */
export function evaluate(
  ruleset: Ruleset,
  flagKey: string,
  context: Context,
  fallback: JsonValue,
): Result {
  const error: Result = { variant: null, value: fallback, reason: 'ERROR' };
  try {
    if (!Object.hasOwn(ruleset.flags, flagKey)) {
      return { variant: null, value: fallback, reason: 'FLAG_NOT_FOUND' };
    }
    const flag = ruleset.flags[flagKey]!;

    if (!flag.enabled) {
      const off = flag.variants.find((v) => v.key === flag.offVariant);
      return off ? { variant: off.key, value: off.value, reason: 'OFF' } : error;
    }

    for (const rule of flag.rules) {
      if (rule.conditions.every((c) => matchCondition(c, context))) {
        const v = resolveServe(flag, rule.serve, context);
        return v
          ? { variant: v.key, value: v.value, reason: 'RULE_MATCH', ruleId: rule.id }
          : error;
      }
    }

    const v = resolveServe(flag, flag.defaultServe, context);
    return v ? { variant: v.key, value: v.value, reason: 'DEFAULT' } : error;
  } catch {
    return error;
  }
}
