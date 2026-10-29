// Domain types shared by the API, SDKs and dashboard (spec §5.1, ADR 0026).

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export type AttributeValue = string | number | boolean;

export type Context = { userId?: string; [attribute: string]: AttributeValue | undefined };

export type Variant = { key: string; value: JsonValue };

export type Operator = 'eq' | 'in' | 'contains' | 'gt' | 'lt' | 'semverGte';

export type Condition = { attribute: string; op: Operator; values: AttributeValue[] };

/** `weight` is in basis points; a rollout's weights sum to 10000. */
export type RolloutEntry = { variant: string; weight: number };

export type Serve = { variant: string } | { rollout: RolloutEntry[]; bucketBy?: string };

/** `conditions` are ANDed; an empty list matches every context. */
export type Rule = { id: string; conditions: Condition[]; serve: Serve };

export type Flag = {
  key: string;
  enabled: boolean;
  variants: Variant[];
  offVariant: string;
  rules: Rule[];
  defaultServe: Serve;
  salt: string;
  version: number;
};

export type Ruleset = { projectVersion: number; flags: Record<string, Flag> };

export type Reason = 'OFF' | 'RULE_MATCH' | 'DEFAULT' | 'FLAG_NOT_FOUND' | 'ERROR';

export type Result = { variant: string | null; value: JsonValue; reason: Reason; ruleId?: string };
