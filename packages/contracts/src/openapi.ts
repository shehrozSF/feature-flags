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
  101: 'Switching Protocols',
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
  426: 'Upgrade Required',
  428: 'Precondition Required',
  429: 'Too Many Requests',
  503: 'Service Unavailable',
};

// WebSocket routes (spec §6.3) are described by hand: a 101 upgrade has no JSON body
// for the registry's response check. Served by the Worker only (deviation D24).
const problemResponse = (status: number) => ({
  description: STATUS_TEXT[status] ?? String(status),
  content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } },
});
const streamResponses = {
  101: {
    description:
      'Switching Protocols. The server sends {"type":"hello","version":N} on connect and {"type":"changed","version":N} after each change; text "ping" is answered "pong". Closed with 1013 when the project already has 100 open sockets, and 4404 if the project is deleted.',
  },
  401: problemResponse(401),
  403: problemResponse(403),
  426: problemResponse(426),
  503: problemResponse(503),
};
const STREAM_PATHS = {
  '/v1/sdk/stream': {
    get: {
      operationId: 'sdk.stream',
      'x-websocket': true,
      summary: 'Change notices for server SDKs (send Upgrade: websocket)',
      security: [{ bearer: [] }],
      responses: streamResponses,
    },
  },
  '/v1/client/stream': {
    get: {
      operationId: 'client.stream',
      'x-websocket': true,
      summary:
        'Change notices for browsers; the client key goes in ?key= (browsers cannot set headers on a WebSocket)',
      security: [],
      parameters: [{ name: 'key', in: 'query', required: true, schema: { type: 'string' } }],
      // Connecting counts as an evaluate against the project's per-minute limit.
      responses: { ...streamResponses, 429: problemResponse(429) },
    },
  },
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
    paths: { ...paths, ...STREAM_PATHS },
  };
}
