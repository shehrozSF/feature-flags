import { describe, expect, it } from 'vitest';
import committed from '../openapi.json';
import { buildOpenApiDocument, ROUTES } from '../src/index';

type Doc = { paths: Record<string, Record<string, { responses: Record<string, unknown> }>> };

describe('route registry', () => {
  it('every route has a unique id and method+path', () => {
    const ids = ROUTES.map((r) => r.id);
    const endpoints = ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(endpoints).size).toBe(endpoints.length);
  });
});

describe('OpenAPI document', () => {
  const doc = buildOpenApiDocument() as Doc;

  it('lists every registry route and status', () => {
    for (const route of ROUTES) {
      const operation = doc.paths[route.path]?.[route.method.toLowerCase()];
      expect(operation, `${route.method} ${route.path}`).toBeDefined();
      for (const status of Object.keys(route.responses)) {
        expect(operation!.responses[status], `${route.id} ${status}`).toBeDefined();
      }
    }
  });

  it('is deterministic', () => {
    expect(JSON.stringify(buildOpenApiDocument())).toBe(JSON.stringify(doc));
  });

  // Drift check: if this fails, run `pnpm --filter @ff/contracts openapi:write`.
  it('committed openapi.json is up to date', () => {
    expect(committed).toEqual(JSON.parse(JSON.stringify(doc)));
  });
});
