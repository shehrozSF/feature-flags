import { describe, expect, it } from 'vitest';
import type { AppDeps } from '../src/http/app';
import { createApp } from '../src/http/app';

// The MCP SDK inside workerd (ADR 0037). Node tests can't catch what only the Workers
// runtime forbids, such as code generation with new Function (the SDK's default ajv
// validator does that). The app is built with stub services: a real admin key can't be
// verified here without Postgres, and the handshake doesn't need one.
const UUID = '3f2a6c1e-8b4d-4e7a-9c2f-1a2b3c4d5e6f';
const adminKey = `ff_admin_${UUID}_${'A'.repeat(43)}`;

const app = createApp({
  keys: { verify: () => Promise.resolve(true) },
  sandboxes: { touch: () => Promise.resolve() },
  flags: {},
  rulesets: {},
  version: 'test',
} as unknown as AppDeps);

const rpc = (method: string, params: unknown = {}) =>
  app.request('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${adminKey}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });

describe('/mcp in workerd', () => {
  it('initialize works', async () => {
    const res = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      result: { serverInfo: { name: 'feature-flags' }, capabilities: { tools: {} } },
    });
  });

  it('tools/list works', async () => {
    const res = await rpc('tools/list');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ result: { tools: [] } });
  });
});
