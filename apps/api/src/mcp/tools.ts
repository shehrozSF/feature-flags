// The MCP tools (addendum 2026-11-12 §2.4). Each one calls the existing HTTP API
// in-process with the caller's own key (ADR 0037), so validation, If-Match and
// propagation all happen exactly as for the dashboard. No business logic here.
import type { FlagResource, Problem } from '@ff/contracts';
import { describeFlag, describeRollout } from '@ff/eval-core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { formatEtag } from '../http/etag';
import { planChange } from './changes';
import { signConfirmToken, verifyConfirmToken, type PendingChange } from './confirm-token';

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

const CHANGE_SCHEMA = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('set_enabled'),
    enabled: z.boolean().describe('true turns the flag on, false turns it off'),
  }),
  z.object({
    type: z.literal('set_rollout'),
    ruleId: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe('The rule to change; leave out to change what everyone else gets'),
    weights: z
      .record(z.string(), z.number().min(0).max(100))
      .describe('Percent per variant, adding up to 100, e.g. {"on": 25, "off": 75}'),
  }),
  z.object({ type: z.literal('archive') }),
]);

const TOKEN_ERRORS: Record<'malformed' | 'bad-signature' | 'expired' | 'wrong-project', string> = {
  malformed: 'that confirm token is invalid: pass the token from propose_flag_change unchanged',
  'bad-signature':
    'that confirm token is invalid: pass the token from propose_flag_change unchanged',
  expired: 'that confirm token has expired (they last 5 minutes): propose the change again',
  'wrong-project': 'that confirm token was made for another project',
};

const toolError = (text: string): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text }],
});

export type WriteToolOptions = {
  /** The caller's project: tokens are bound to it. */
  projectId: string;
  /** Signs confirm tokens (ADR 0038). */
  confirmSecret: string;
};

/**
 * The only path to a write: propose (reads, previews, signs), then apply (checks
 * the token, then sends exactly what was signed, with If-Match). ADR 0038.
 */
export function registerWriteTools(
  server: McpServer,
  callApi: CallApi,
  { projectId, confirmSecret }: WriteToolOptions,
): void {
  server.registerTool(
    'propose_flag_change',
    {
      title: 'Propose a flag change',
      description:
        'Previews a change and returns a confirmToken. Changes NOTHING by itself. Show the ' +
        'user the summary (before → after) and ask them to confirm; only then call ' +
        'apply_flag_change with the token. Changes: set_enabled (on/off), set_rollout ' +
        '(percentages for a rule, or for everyone else without ruleId), archive.',
      inputSchema: {
        key: z.string().min(1).max(64).describe('The flag key, e.g. "checkout-v2"'),
        change: CHANGE_SCHEMA,
      },
      annotations: READ_ONLY, // it only reads and signs: the write is apply_flag_change
    },
    async ({ key, change }) => {
      const res = await callApi('GET', flagPath(key));
      if (!res.ok) return apiError(res);
      const flag = (await res.json()) as FlagResource;

      const plan = planChange(flag, change);
      if (!plan.ok) return toolError(`Can't propose that: ${plan.message}`);

      const pending: PendingChange =
        plan.op === 'archive'
          ? { projectId, key, baseVersion: flag.version, op: 'archive' }
          : { projectId, key, baseVersion: flag.version, op: 'update', body: plan.body };
      const { token, expiresAt } = await signConfirmToken(pending, confirmSecret);
      return result({
        summary: plan.summary,
        before: plan.before,
        after: plan.after,
        request:
          plan.op === 'archive'
            ? { method: 'DELETE', path: flagPath(key) }
            : { method: 'PATCH', path: flagPath(key), body: plan.body },
        basedOnVersion: flag.version,
        confirmToken: token,
        expiresAt,
        next: 'Show the user the summary. Call apply_flag_change with confirmToken only after they confirm.',
      });
    },
  );

  server.registerTool(
    'apply_flag_change',
    {
      title: 'Apply a confirmed flag change',
      description:
        'Makes the change a propose_flag_change call previewed, exactly as previewed. Only ' +
        'call this after the user has seen the summary and confirmed. Fails if the token ' +
        'expired (5 minutes) or the flag changed since the preview.',
      inputSchema: {
        // Asked for even though the token names it: the client's approval prompt
        // shows the arguments, so the person approving sees which flag (review #2).
        key: z.string().min(1).max(64).describe('The flag key the proposal was for'),
        // A rule change carries every rule, so a flag at the 32 KB rules limit makes
        // a ~44 KB token (base64). 60,000 still fits the 64 KB body limit (review #1).
        confirmToken: z.string().min(1).max(60_000).describe('The token from propose_flag_change'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true, // it can archive a flag
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ key, confirmToken }) => {
      const verified = await verifyConfirmToken(confirmToken, confirmSecret, { projectId });
      if (!verified.ok) return toolError(`Not applied: ${TOKEN_ERRORS[verified.reason]}`);
      const { change } = verified;
      if (change.key !== key) {
        return toolError(`Not applied: that confirm token is for "${change.key}", not "${key}"`);
      }
      const headers = { 'if-match': formatEtag(change.baseVersion) };

      const res =
        change.op === 'archive'
          ? await callApi('DELETE', flagPath(change.key), { headers })
          : await callApi('PATCH', flagPath(change.key), { headers, body: change.body });

      if (res.status === 409) {
        const { current } = (await res.json()) as { current?: FlagResource };
        return toolError(
          `Not applied: "${change.key}" changed since the preview (it was version ` +
            `${change.baseVersion}, now ${current?.version ?? 'newer'}). ` +
            'Read it again and propose the change again.',
        );
      }
      if (!res.ok) return apiError(res);

      const propagation =
        res.headers.get('x-propagation') === 'delayed'
          ? 'saved, but live SDKs will only see it on their next refresh'
          : 'live';
      if (change.op === 'archive') {
        return result({ applied: true, summary: `Archived "${change.key}".`, propagation });
      }
      const flag = (await res.json()) as FlagResource;
      return result({
        applied: true,
        summary: `"${flag.key}" now: ${describeFlag(flag)}`,
        version: flag.version,
        propagation,
      });
    },
  );
}
