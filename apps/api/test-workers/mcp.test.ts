import { describe, expect, it } from 'vitest';
import type { AppDeps } from '../src/http/app';
import { createApp } from '../src/http/app';
import { signConfirmToken, verifyConfirmToken } from '../src/mcp/confirm-token';
import { signatureHeader } from '../src/webhooks/dispatcher';

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
    const { result } = await res.json<{ result: { tools: { name: string }[] } }>();
    expect(result.tools.map((t) => t.name)).toEqual(['list_flags', 'get_flag']);
  });
});

describe('confirm token in workerd', () => {
  // HMAC, btoa/atob and TextDecoder come from the runtime: check workerd's, not just Node's.
  it('signs and verifies; a different secret fails', async () => {
    const secret = 'workerd-secret-that-is-long-enough-01234';
    const change = { projectId: UUID, key: 'f', baseVersion: 1, op: 'archive' } as const;
    const { token } = await signConfirmToken(change, secret);
    expect(await verifyConfirmToken(token, secret, { projectId: UUID })).toEqual({
      ok: true,
      change,
    });
    expect(await verifyConfirmToken(token, `${secret}x`, { projectId: UUID })).toMatchObject({
      ok: false,
      reason: 'bad-signature',
    });
  });
});

describe('webhook signing in workerd', () => {
  // The same HMAC as Node's crypto (value computed with createHmac in Node), so a
  // receiver verifies Worker-signed events exactly as the Node tests check them.
  it('signatureHeader matches a reference computed in Node', async () => {
    const header = await signatureHeader(
      `whsec_${'k'.repeat(43)}`,
      '{"type":"ping"}',
      1_700_000_000_000,
    );
    expect(header).toBe(
      't=1700000000,v1=54b7f9e4d7f2858a64882a03f5bc09080107a2e1baa655a8611605e2256bc898',
    );
  });
});
