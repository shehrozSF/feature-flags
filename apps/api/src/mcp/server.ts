// The MCP endpoint (addendum 2026-11-12 §2, ADR 0037): Streamable HTTP in stateless
// mode. Every request gets a fresh server and transport, so nothing is shared between
// requests or clients and no Durable Object is needed. The admin key has already been
// checked by the route's middleware before a request reaches this file.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
import { registerReadTools, type CallApi } from './tools';

export const MCP_SERVER_NAME = 'feature-flags';

const INSTRUCTIONS =
  'Manage the feature flags of one project (the one the admin key belongs to). ' +
  'Read tools never change anything. To change a flag, call propose_flag_change, ' +
  'show the user the summary and diff, and only call apply_flag_change after they confirm.';

export type McpContext = {
  /** Reported as the server version, e.g. the git commit. */
  version: string;
  /** Calls our own API in-process with the caller's key. */
  callApi: CallApi;
};

function createMcpServer({ version, callApi }: McpContext): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version },
    {
      // Declaring tools up front makes tools/list answer even before any tool exists.
      capabilities: { tools: {} },
      instructions: INSTRUCTIONS,
      // The SDK's default validator (ajv) compiles schemas with new Function, which
      // workerd forbids; this one interprets them instead.
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
    },
  );
  registerReadTools(server, callApi);
  return server;
}

export async function handleMcpRequest(request: Request, context: McpContext): Promise<Response> {
  const server = createMcpServer(context);
  // No sessionIdGenerator = stateless: no Mcp-Session-Id, every request stands alone.
  const transport = new WebStandardStreamableHTTPServerTransport({
    // Plain JSON responses instead of an SSE stream: every tool answers in one go,
    // and JSON is easier to log, test and proxy.
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}
