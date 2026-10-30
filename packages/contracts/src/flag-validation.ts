// Cross-field flag rules that a field-by-field schema can't express: every
// reference must point at a real variant, and rollouts must cover exactly 100%.
// Used when creating a flag and again on the merged result of a PATCH.
import { BUCKET_COUNT } from '@ff/eval-core';
import { LIMITS } from './limits';

type ServeLike = {
  variant?: string | undefined;
  rollout?: { variant: string; weight: number }[] | undefined;
};
type FlagShape = {
  variants: { key: string }[];
  offVariant: string;
  rules: { id: string; serve: ServeLike }[];
  defaultServe: ServeLike;
};

/** UTF-8 byte length, counted per code point (no TextEncoder needed). */
function utf8Length(s: string): number {
  let bytes = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

export function validateFlagShape(flag: FlagShape): { path: string; message: string }[] {
  const errors: { path: string; message: string }[] = [];
  const keys = new Set<string>();

  flag.variants.forEach((v, i) => {
    if (keys.has(v.key))
      errors.push({ path: `variants.${i}.key`, message: `duplicate variant "${v.key}"` });
    keys.add(v.key);
  });

  const checkVariant = (key: string, path: string) => {
    if (!keys.has(key)) errors.push({ path, message: `unknown variant "${key}"` });
  };

  const checkServe = (serve: ServeLike, path: string) => {
    if (serve.variant !== undefined) checkVariant(serve.variant, `${path}.variant`);
    if (serve.rollout !== undefined) {
      const seen = new Set<string>();
      serve.rollout.forEach((entry, i) => {
        checkVariant(entry.variant, `${path}.rollout.${i}.variant`);
        if (seen.has(entry.variant)) {
          errors.push({ path: `${path}.rollout.${i}.variant`, message: 'variant listed twice' });
        }
        seen.add(entry.variant);
      });
      const total = serve.rollout.reduce((sum, e) => sum + e.weight, 0);
      if (total !== BUCKET_COUNT) {
        errors.push({
          path: `${path}.rollout`,
          message: `weights must add up to ${BUCKET_COUNT}, got ${total}`,
        });
      }
    }
  };

  checkVariant(flag.offVariant, 'offVariant');

  const ruleIds = new Set<string>();
  flag.rules.forEach((rule, i) => {
    if (ruleIds.has(rule.id))
      errors.push({ path: `rules.${i}.id`, message: `duplicate rule id "${rule.id}"` });
    ruleIds.add(rule.id);
    checkServe(rule.serve, `rules.${i}.serve`);
  });
  if (utf8Length(JSON.stringify(flag.rules)) > LIMITS.rulesJsonBytes) {
    errors.push({
      path: 'rules',
      message: `rules may be at most ${LIMITS.rulesJsonBytes} bytes of JSON`,
    });
  }

  checkServe(flag.defaultServe, 'defaultServe');
  return errors;
}
