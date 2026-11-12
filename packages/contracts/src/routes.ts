// Every HTTP route the API serves, with the schema of each request body and of
// every response status. The API's contract tests check real responses against
// this, and the OpenAPI document is generated from it (ADR 0027).
import type { z } from 'zod';
import {
  ConflictProblemSchema,
  EvaluateRequestSchema,
  EvaluateResponseSchema,
  FlagInputSchema,
  FlagPatchSchema,
  FlagSchema,
  HealthSchema,
  ProblemSchema,
  RulesetSchema,
  SandboxResponseSchema,
  WebhookCreatedSchema,
  WebhookInputSchema,
  WebhookSchema,
} from './schemas';
import { z as zod } from 'zod';

export type AuthKind = 'none' | 'admin' | 'server' | 'client';

export type RouteDef = {
  id: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** OpenAPI style, e.g. '/v1/flags/{key}'. */
  path: string;
  auth: AuthKind;
  body?: z.ZodType;
  /** Status → body schema; `null` means the response has no body. */
  responses: Record<number, z.ZodType | null>;
};

export const FlagListSchema = zod.object({ flags: zod.array(FlagSchema) });

const P = ProblemSchema;

export const ROUTES: readonly RouteDef[] = [
  {
    id: 'sandboxes.create',
    method: 'POST',
    path: '/v1/sandboxes',
    auth: 'none',
    responses: { 201: SandboxResponseSchema, 429: P, 503: P },
  },
  {
    id: 'flags.list',
    method: 'GET',
    path: '/v1/flags',
    auth: 'admin',
    responses: { 200: FlagListSchema, 401: P, 403: P, 503: P },
  },
  {
    id: 'flags.create',
    method: 'POST',
    path: '/v1/flags',
    auth: 'admin',
    body: FlagInputSchema,
    responses: { 201: FlagSchema, 400: P, 401: P, 403: P, 404: P, 409: P, 413: P, 422: P, 503: P },
  },
  {
    id: 'flags.get',
    method: 'GET',
    path: '/v1/flags/{key}',
    auth: 'admin',
    responses: { 200: FlagSchema, 401: P, 403: P, 404: P, 503: P },
  },
  {
    id: 'flags.update',
    method: 'PATCH',
    path: '/v1/flags/{key}',
    auth: 'admin',
    body: FlagPatchSchema,
    responses: {
      200: FlagSchema,
      400: P,
      401: P,
      403: P,
      404: P,
      409: ConflictProblemSchema,
      413: P,
      422: P,
      428: P,
      503: P,
    },
  },
  {
    id: 'flags.archive',
    method: 'DELETE',
    path: '/v1/flags/{key}',
    auth: 'admin',
    responses: { 204: null, 401: P, 403: P, 404: P, 409: ConflictProblemSchema, 428: P, 503: P },
  },
  // One webhook per project (ADR 0039). PUT creates or replaces it, with a new secret.
  {
    id: 'webhook.set',
    method: 'PUT',
    path: '/v1/webhook',
    auth: 'admin',
    body: WebhookInputSchema,
    responses: { 200: WebhookCreatedSchema, 400: P, 401: P, 403: P, 422: P, 503: P },
  },
  {
    id: 'webhook.get',
    method: 'GET',
    path: '/v1/webhook',
    auth: 'admin',
    responses: { 200: WebhookSchema, 401: P, 403: P, 404: P, 503: P },
  },
  {
    id: 'webhook.delete',
    method: 'DELETE',
    path: '/v1/webhook',
    auth: 'admin',
    responses: { 204: null, 401: P, 403: P, 404: P, 503: P },
  },
  {
    id: 'sdk.rules',
    method: 'GET',
    path: '/v1/sdk/rules',
    auth: 'server',
    responses: { 200: RulesetSchema, 304: null, 401: P, 403: P, 503: P },
  },
  {
    id: 'client.evaluate',
    method: 'POST',
    path: '/v1/client/evaluate',
    auth: 'client',
    body: EvaluateRequestSchema,
    responses: {
      200: EvaluateResponseSchema,
      400: P,
      401: P,
      403: P,
      413: P,
      422: P,
      429: P,
      503: P,
    },
  },
  {
    id: 'health',
    method: 'GET',
    path: '/health',
    auth: 'none',
    responses: { 200: HealthSchema },
  },
];
