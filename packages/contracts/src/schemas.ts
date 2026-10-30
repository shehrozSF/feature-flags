// Request/response shapes for the API, shared by the API, SDKs and dashboard.
// Domain types come from eval-core; schemas that mirror them are annotated with
// those types so the two can't drift apart (ADR 0026).
import type { Context, Flag, JsonValue, Result, Ruleset } from '@ff/eval-core';
import { z } from 'zod';
import { validateFlagShape } from './flag-validation';
import { FLAG_KEY_PATTERN, LIMITS } from './limits';

export { exceedsJsonDepth } from './limits';
export { FLAG_KEY_PATTERN, LIMITS };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

const AttributeValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export const ContextSchema = z
  .record(z.string(), AttributeValueSchema)
  .refine((c) => Object.keys(c).length <= LIMITS.contextKeys, {
    message: `context may have at most ${LIMITS.contextKeys} attributes`,
  }) as unknown as z.ZodType<Context>;

export const VariantSchema = z.object({ key: z.string().min(1).max(64), value: JsonValueSchema });

export const ConditionSchema = z.object({
  attribute: z.string().min(1).max(64),
  op: z.enum(['eq', 'in', 'contains', 'gt', 'lt', 'semverGte']),
  values: z.array(AttributeValueSchema).min(1),
});

const RolloutEntrySchema = z.object({
  variant: z.string(),
  weight: z.number().int().nonnegative(),
});

// One object schema rather than a union, so errors point at the exact field
// (a union only reports "no option matched").
export const ServeSchema = z
  .object({
    variant: z.string().optional(),
    rollout: z.array(RolloutEntrySchema).min(1).optional(),
    bucketBy: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    if ((s.variant === undefined) === (s.rollout === undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'serve needs exactly one of "variant" or "rollout"',
      });
    }
    if (s.variant !== undefined && s.bucketBy !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['bucketBy'],
        message: 'bucketBy only applies to rollouts',
      });
    }
  });

export const RuleSchema = z.object({
  id: z.string().min(1).max(64),
  conditions: z.array(ConditionSchema).max(LIMITS.conditionsPerRule),
  serve: ServeSchema,
});

const flagFields = {
  name: z.string().min(1).max(100),
  description: z.string().max(500),
  enabled: z.boolean(),
  variants: z.array(VariantSchema).min(1).max(LIMITS.variantsPerFlag),
  offVariant: z.string(),
  rules: z.array(RuleSchema).max(LIMITS.rulesPerFlag),
  defaultServe: ServeSchema,
};

export const FlagInputSchema = z
  .object({
    key: z.string().regex(FLAG_KEY_PATTERN, 'lowercase letters, digits and dashes; max 64'),
    ...flagFields,
    description: flagFields.description.default(''),
    enabled: flagFields.enabled.default(false),
    rules: flagFields.rules.default([]),
  })
  .strict()
  .superRefine((flag, ctx) => {
    for (const e of validateFlagShape(flag)) {
      ctx.addIssue({ code: 'custom', path: e.path ? e.path.split('.') : [], message: e.message });
    }
  });

/** PATCH body: any flag field except the key; at least one. Cross-field checks run on the merged flag. */
export const FlagPatchSchema = z
  .object(flagFields)
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, { message: 'patch must change at least one field' });

export type FlagInput = z.infer<typeof FlagInputSchema>;
export type FlagPatch = z.infer<typeof FlagPatchSchema>;
export type FlagResource = Flag & { name: string; description: string; updatedAt: string };

const flagResourceObject = z.object({
  key: z.string(),
  ...flagFields,
  salt: z.string(),
  version: z.number().int().positive(),
  updatedAt: z.string(),
});
export const FlagSchema = flagResourceObject as unknown as z.ZodType<FlagResource>;

export const RulesetSchema = z.object({
  projectVersion: z.number().int().positive(),
  flags: z.record(
    z.string(),
    flagResourceObject.omit({ name: true, description: true, updatedAt: true }),
  ),
}) as unknown as z.ZodType<Ruleset>;

export const ResultSchema = z.object({
  variant: z.string().nullable(),
  value: JsonValueSchema,
  reason: z.enum(['OFF', 'RULE_MATCH', 'DEFAULT', 'FLAG_NOT_FOUND', 'ERROR']),
  ruleId: z.string().optional(),
}) as unknown as z.ZodType<Result>;

export const EvaluateRequestSchema = z.object({ context: ContextSchema }).strict();
export const EvaluateResponseSchema = z.object({
  version: z.number().int().positive(),
  flags: z.record(z.string(), ResultSchema),
});

const KEY_PATTERN = /^ff_(admin|server|client)_[0-9a-f-]{36}_[0-9A-Za-z]{43}$/;
export const SandboxResponseSchema = z.object({
  projectId: z.uuid(),
  keys: z.object({
    admin: z.string().regex(KEY_PATTERN),
    server: z.string().regex(KEY_PATTERN),
    client: z.string().regex(KEY_PATTERN),
  }),
});

export const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type Problem = z.infer<typeof ProblemSchema>;

/** 409 on update/archive: the problem plus the flag as it is now. */
export const ConflictProblemSchema = ProblemSchema.extend({ current: FlagSchema });

export const HealthSchema = z.object({ status: z.literal('ok'), version: z.string() });

export type FieldError = { path: string; message: string };

export function toFieldErrors(error: z.ZodError): FieldError[] {
  return error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}
