// Who gets what, in percentages: for the MCP tools, webhook messages and summaries
// (addendum 2026-11-12 §2.7). Weights are basis points, so 2500 is 25%.
import { BUCKET_COUNT } from './bucket';
import type { Flag, Serve } from './types';

/** One variant's share of a serve, in percent (0-100, up to two decimals). */
export type Share = { variant: string; percent: number };

export type RolloutSummary = {
  enabled: boolean;
  /** What everyone gets while the flag is off. */
  offVariant: string;
  /** Each rule in order, then what everyone else gets. */
  rules: { ruleId: string; shares: Share[] }[];
  defaultShares: Share[];
  /** On, and at least one serve splits users between variants (a rollout in progress). */
  splitting: boolean;
  /** One line, e.g. "rule beta: on 100% · everyone else: on 25%, off 75%". */
  text: string;
};

/** Basis points to percent: 2500 → 25, 1 → 0.01. */
export const percentOf = (basisPoints: number): number => (basisPoints / BUCKET_COUNT) * 100;

/** A single variant is 100% of that variant; a rollout lists its entries in order. */
export function serveShares(serve: Serve): Share[] {
  if ('variant' in serve) return [{ variant: serve.variant, percent: 100 }];
  return serve.rollout.map((r) => ({ variant: r.variant, percent: percentOf(r.weight) }));
}

/** True when some users get one variant and some another: a share strictly between 0 and 100. */
export const isSplit = (shares: Share[]): boolean =>
  shares.some((s) => s.percent > 0 && s.percent < 100);

const sharesText = (shares: Share[]) =>
  shares.length === 0 ? 'nothing' : shares.map((s) => `${s.variant} ${s.percent}%`).join(', ');

export function describeRollout(flag: Flag): RolloutSummary {
  const rules = flag.rules.map((r) => ({ ruleId: r.id, shares: serveShares(r.serve) }));
  const defaultShares = serveShares(flag.defaultServe);
  const splitting =
    flag.enabled && (isSplit(defaultShares) || rules.some((r) => isSplit(r.shares)));
  const text = flag.enabled
    ? [
        ...rules.map((r) => `rule ${r.ruleId}: ${sharesText(r.shares)}`),
        `${rules.length ? 'everyone else' : 'everyone'}: ${sharesText(defaultShares)}`,
      ].join(' · ')
    : `off: everyone gets ${flag.offVariant}`;
  return {
    enabled: flag.enabled,
    offVariant: flag.offVariant,
    rules,
    defaultShares,
    splitting,
    text,
  };
}
