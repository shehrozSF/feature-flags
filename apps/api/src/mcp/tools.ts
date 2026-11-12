// The MCP tools (addendum 2026-11-12 §2.4). Each one calls the existing HTTP API
// in-process with the caller's own key (ADR 0037), so validation, If-Match and
// propagation all happen exactly as for the dashboard. No business logic here.
import type { FlagResource, Problem } from '@ff/contracts';
import { describeRollout } from '@ff/eval-core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

/** One request to our own API, already carrying the caller's admin key. */
export type CallApi = (
  method: 'GET' | 'PATCH' | 'DELETE',
  path: string,
  init?: { body?: unknown; headers?: Record<string, string> },
) => Promise<Response>;

const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;

/** Pretty JSON: models read it reliably, and people reading a transcript can too. */
const result = (data: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
});

/**
 * An API error as a tool error: the model sees what went wrong and can recover
 * (e.g. a wrong key), instead of the whole MCP request failing.
 */
async function apiError(res: Response): Promise<CallToolResult> {
  const problem = (await res.json().catch(() => ({}))) as Partial<Problem>;
  const message = `API error ${res.status}: ${problem.detail ?? problem.title ?? 'no details'}`;
  return { isError: true, content: [{ type: 'text', text: message }] };
}

const flagPath = (key: string) => `/v1/flags/${encodeURIComponent(key)}`;

export function registerReadTools(server: McpServer, callApi: CallApi): void {
  server.registerTool(
    'list_flags',
    {
      title: 'List flags',
      description:
        'Every flag in the project, with whether it is on, its version and who gets what ' +
        '(percentages per rule). "splitting" is true while a rollout is in progress. Changes nothing.',
      annotations: READ_ONLY,
    },
    async () => {
      const res = await callApi('GET', '/v1/flags');
      if (!res.ok) return apiError(res);
      const { flags } = (await res.json()) as { flags: FlagResource[] };
      return result({
        flags: flags.map((flag) => {
          const rollout = describeRollout(flag);
          return {
            key: flag.key,
            name: flag.name,
            enabled: flag.enabled,
            version: flag.version,
            rollout: rollout.text,
            splitting: rollout.splitting,
          };
        }),
      });
    },
  );

  server.registerTool(
    'get_flag',
    {
      title: 'Get a flag',
      description:
        'One flag in full (variants, rules, default serve, version) plus its rollout in ' +
        'percentages. Changes nothing.',
      inputSchema: { key: z.string().min(1).max(64).describe('The flag key, e.g. "checkout-v2"') },
      annotations: READ_ONLY,
    },
    async ({ key }) => {
      const res = await callApi('GET', flagPath(key));
      if (!res.ok) return apiError(res);
      const flag = (await res.json()) as FlagResource;
      return result({ flag, rollout: describeRollout(flag) });
    },
  );
}
