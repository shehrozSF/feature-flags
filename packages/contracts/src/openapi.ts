// Builds the OpenAPI 3.1 document from the zod schemas and the route registry,
// so the published API description can never drift from what the code checks.
import { z } from 'zod';
import { FlagListSchema, ROUTES } from './routes';
import {
  ConflictProblemSchema,
  ContextSchema,
  EvaluateRequestSchema,
  EvaluateResponseSchema,
  FlagInputSchema,
  FlagPatchSchema,
  FlagSchema,
  HealthSchema,
  JsonValueSchema,
  ProblemSchema,
  ResultSchema,
  RulesetSchema,
  SandboxResponseSchema,
} from './schemas';

// Every schema gets a stable name, so references point at
// #/components/schemas/<Name> instead of nested $defs.
const NAMED: [string, z.ZodType][] = [
  ['JsonValue', JsonValueSchema],
  ['Context', ContextSchema],
  ['Flag', FlagSchema],
  ['FlagList', FlagListSchema],
  ['FlagInput', FlagInputSchema],
  ['FlagPatch', FlagPatchSchema],
  ['Ruleset', RulesetSchema],
  ['Result', ResultSchema],
  ['EvaluateRequest', EvaluateRequestSchema],
  ['EvaluateResponse', EvaluateResponseSchema],
  ['SandboxResponse', SandboxResponseSchema],
  ['Problem', ProblemSchema],
  ['ConflictProblem', ConflictProblemSchema],
  ['Health', HealthSchema],
];

const REQUEST_NAMES = new Set(['FlagInput', 'FlagPatch', 'EvaluateRequest']);
const nameOf = new Map(NAMED.map(([name, schema]) => [schema, name]));

function componentSchemas(io: 'input' | 'output'): Record<string, unknown> {
  const registry = z.registry<{ id: string }>();
  for (const [id, schema] of NAMED) registry.add(schema, { id });
  const { schemas } = z.toJSONSchema(registry, {
    io,
    unrepresentable: 'any',
    uri: (id) => `#/components/schemas/${id}`,
  });
  // Each component carries its own "$schema"/"$id"; OpenAPI doesn't want them.
  return Object.fromEntries(
    Object.entries(schemas).map(([id, s]) => {
      const rest = { ...(s as Record<string, unknown>) };
      delete rest.$schema;
      delete rest.$id;
      return [id, rest];
    }),
  );
}

const ref = (schema: z.ZodType) => ({ $ref: `#/components/schemas/${nameOf.get(schema)}` });

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Payload Too Large',
  422: 'Unprocessable Content',
  428: 'Precondition Required',
};

export function buildOpenApiDocument(): object {
  const input = componentSchemas('input');
  const output = componentSchemas('output');
  const schemas = Object.fromEntries(
    NAMED.map(([name]) => [name, REQUEST_NAMES.has(name) ? input[name] : output[name]]),
  );

  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of ROUTES) {
    const responses = Object.fromEntries(
      Object.entries(route.responses).map(([status, schema]) => {
        const description = STATUS_TEXT[Number(status)] ?? status;
        if (schema === null) return [status, { description }];
        const type = Number(status) >= 400 ? 'application/problem+json' : 'application/json';
        return [status, { description, content: { [type]: { schema: ref(schema) } } }];
      }),
    );
    paths[route.path] ??= {};
    paths[route.path]![route.method.toLowerCase()] = {
      operationId: route.id,
      ...(route.auth === 'none' ? { security: [] } : { security: [{ bearer: [] }] }),
      ...(route.path.includes('{key}')
        ? { parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }] }
        : {}),
      ...(route.body
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: ref(route.body) } },
            },
          }
        : {}),
      responses,
    };
  }

  return {
    openapi: '3.1.0',
    info: { title: 'Feature flag API', version: '1' },
    components: {
      schemas,
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', description: 'ff_<kind>_<projectId>_<secret>' },
      },
    },
    paths,
  };
}
