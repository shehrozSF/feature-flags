import { describe, expect, it } from 'vitest';
import type { AppDeps } from '../src/http/app';
import { createApp } from '../src/http/app';

// The /mcp endpoint's plumbing: auth, the MCP handshake and tool listing. No tool
// touches the database yet, so the services are stubs; tools get Postgres-backed
// tests once they exist (Tasks 4-5).
const UUID = '3f2a6c1e-8b4d-4e7a-9c2f-1a2b3c4d5e6f';
const key = (kind: string) => `ff_${kind}_${UUID}_${'A'.repeat(43)}`;

const app = createApp({
  keys: { verify: () => Promise.resolve(true) },
  sandboxes: { touch: () => Promise.resolve() },
  flags: {},
  rulesets: {},
  version: 'test',
} as unknown as AppDeps);

// Streamable HTTP requires the client to accept both JSON and SSE.
const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

async function rpc(method: string, params: unknown = {}, authKey = key('admin')) {
  return app.request('/mcp', {
    method: 'POST',
    headers: { ...MCP_HEADERS, authorization: `Bearer ${authKey}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

const INITIALIZE = {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'test', version: '0' },
};

describe('/mcp', () => {
  it('initialize names the server, offers tools and explains the confirm step', async () => {
    const res = await rpc('initialize', INITIALIZE);
    expect(res.status).toBe(200);
    // Stateless: no session for the client to carry around.
    expect(res.headers.get('mcp-session-id')).toBeNull();
    const body = (await res.json()) as {
      result: { serverInfo: unknown; capabilities: unknown; instructions: string };
    };
    expect(body.result.serverInfo).toEqual({ name: 'feature-flags', version: 'test' });
    expect(body.result.capabilities).toMatchObject({ tools: {} });
    expect(body.result.instructions).toContain('apply_flag_change');
  });

  it('tools/list answers on a fresh request, with no earlier initialize', async () => {
    // Each stateless request stands alone: the transport mustn't demand the handshake
    // first, or every tool call from a client would fail after the first one.
    const res = await rpc('tools/list');
    expect(res.status).toBe(200);
    const { result } = (await res.json()) as { result: { tools: { name: string }[] } };
    expect(result.tools.map((t) => t.name)).toEqual(['list_flags', 'get_flag']);
  });

  it('needs an admin key: none gets 401, a server key 403', async () => {
    const none = await app.request('/mcp', { method: 'POST', headers: MCP_HEADERS, body: '{}' });
    expect(none.status).toBe(401);
    expect((await rpc('tools/list', {}, key('server'))).status).toBe(403);
    expect((await rpc('tools/list', {}, key('client'))).status).toBe(403);
  });

  it.each(['GET', 'DELETE'])(
    '%s is refused: stateless mode has no server-to-client stream or session',
    async (method) => {
      // Left to the SDK, GET answers 200 with an SSE stream that stays open, idle.
      const res = await app.request('/mcp', {
        method,
        headers: { accept: 'text/event-stream', authorization: `Bearer ${key('admin')}` },
      });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
      expect(res.headers.get('content-type')).toContain('application/problem+json');
    },
  );
});
