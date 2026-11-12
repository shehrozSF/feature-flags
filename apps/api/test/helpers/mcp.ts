// Talks to /mcp the way an MCP client does: JSON-RPC over POST, one request per
// call (the server is stateless, so no initialize is needed first).
import { expect } from 'vitest';

type App = { request(path: string, init: RequestInit): Response | Promise<Response> };

// Streamable HTTP requires the client to accept both JSON and SSE.
export const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

export async function mcpRequest(
  app: App,
  key: string,
  method: string,
  params: unknown = {},
  headers: Record<string, string> = {},
) {
  return app.request('/mcp', {
    method: 'POST',
    headers: { ...MCP_HEADERS, ...headers, authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

export type ToolOutcome = { isError: boolean; text: string; data: unknown };

/** Calls a tool; `data` is the parsed JSON text when the tool returned JSON. */
export async function callTool(
  app: App,
  key: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolOutcome> {
  const res = await mcpRequest(app, key, 'tools/call', { name, arguments: args });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    result?: { isError?: boolean; content: { type: string; text: string }[] };
    error?: unknown;
  };
  expect(body.error, 'a JSON-RPC error instead of a tool result').toBeUndefined();
  const text = body.result!.content.map((c) => c.text).join('\n');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  return { isError: body.result!.isError === true, text, data };
}
