#!/usr/bin/env node
// Builds the two n8n workflows (ADR 0040) from code/*.js, so the JavaScript that runs
// inside n8n is a normal file with tests. Like openapi.json: the JSON files are
// committed, and code.test.mjs fails if they differ from what this script builds.
//   node tools/n8n/workflows.mjs          write workflows/*.json
//   node tools/n8n/workflows.mjs --check  exit 1 if they're out of date
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const here = import.meta.dirname;
const code = (name) => readFileSync(join(here, 'code', name), 'utf8');

// Fixed ids, so building twice gives the same file and imports update in place.
const node = (id, name, type, typeVersion, position, parameters, extra = {}) => ({
  id,
  name,
  type,
  typeVersion,
  position,
  parameters,
  ...extra,
});

/** POST { content } to the Discord channel webhook named in the container's env. */
const discord = (id, position) =>
  node(id, 'Post to Discord', 'n8n-nodes-base.httpRequest', 4.2, position, {
    method: 'POST',
    url: '={{ $env.DISCORD_WEBHOOK_URL }}',
    sendBody: true,
    specifyBody: 'json',
    // No pings: a variant key or rule id like @everyone stays plain text (review M-5).
    jsonBody: '={{ JSON.stringify({ content: $json.content, allowed_mentions: { parse: [] } }) }}',
    options: {},
  });

const flagChange = {
  id: 'ffFlagChange0001',
  name: 'Feature flags: change to Discord',
  active: false,
  settings: { executionOrder: 'v1' },
  nodes: [
    node(
      'b1f0c6d2-0000-4000-8000-000000000001',
      'Flag change',
      'n8n-nodes-base.webhook',
      2,
      [0, 0],
      { httpMethod: 'POST', path: 'ff-flag-change', responseMode: 'responseNode', options: {} },
      { webhookId: 'b1f0c6d2-0000-4000-8000-0000000000aa' },
    ),
    node(
      'b1f0c6d2-0000-4000-8000-000000000002',
      'Verify and format',
      'n8n-nodes-base.code',
      2,
      [220, 0],
      { jsCode: code('flag-change.js') },
    ),
    node(
      'b1f0c6d2-0000-4000-8000-000000000003',
      'Signature valid?',
      'n8n-nodes-base.if',
      2,
      [440, 0],
      {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
          conditions: [
            {
              id: 'b1f0c6d2-0000-4000-8000-0000000000c1',
              leftValue: '={{ $json.valid }}',
              rightValue: '',
              operator: { type: 'boolean', operation: 'true', singleValue: true },
            },
          ],
          combinator: 'and',
        },
        options: {},
      },
    ),
    // Already posted (a retry after a lost answer, or a replay): answer 200, post nothing.
    node(
      'b1f0c6d2-0000-4000-8000-000000000007',
      'Already posted?',
      'n8n-nodes-base.if',
      2,
      [660, -100],
      {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
          conditions: [
            {
              id: 'b1f0c6d2-0000-4000-8000-0000000000c2',
              leftValue: '={{ $json.duplicate }}',
              rightValue: '',
              operator: { type: 'boolean', operation: 'true', singleValue: true },
            },
          ],
          combinator: 'and',
        },
        options: {},
      },
    ),
    discord('b1f0c6d2-0000-4000-8000-000000000004', [880, -40]),
    node(
      'b1f0c6d2-0000-4000-8000-000000000008',
      'Remember event',
      'n8n-nodes-base.code',
      2,
      [1100, -40],
      { jsCode: code('remember-event.js') },
    ),
    node(
      'b1f0c6d2-0000-4000-8000-000000000005',
      'Accepted',
      'n8n-nodes-base.respondToWebhook',
      1.1,
      [1320, -160],
      { respondWith: 'noData', options: { responseCode: 200 } },
    ),
    // A bad signature gets 401; the API counts any 4xx as refused and won't retry.
    node(
      'b1f0c6d2-0000-4000-8000-000000000006',
      'Refused',
      'n8n-nodes-base.respondToWebhook',
      1.1,
      [660, 100],
      { respondWith: 'noData', options: { responseCode: 401 } },
    ),
  ],
  connections: {
    'Flag change': { main: [[{ node: 'Verify and format', type: 'main', index: 0 }]] },
    'Verify and format': { main: [[{ node: 'Signature valid?', type: 'main', index: 0 }]] },
    'Signature valid?': {
      main: [
        [{ node: 'Already posted?', type: 'main', index: 0 }],
        [{ node: 'Refused', type: 'main', index: 0 }],
      ],
    },
    'Already posted?': {
      main: [
        [{ node: 'Accepted', type: 'main', index: 0 }],
        [{ node: 'Post to Discord', type: 'main', index: 0 }],
      ],
    },
    // Answered only after Discord took it: if Discord fails, n8n answers 500 and the
    // API retries the event (not yet remembered, so the retry is posted).
    'Post to Discord': { main: [[{ node: 'Remember event', type: 'main', index: 0 }]] },
    'Remember event': { main: [[{ node: 'Accepted', type: 'main', index: 0 }]] },
  },
};

const dailySummary = {
  id: 'ffDailySummary01',
  name: 'Feature flags: daily rollout summary',
  active: false,
  settings: { executionOrder: 'v1' },
  nodes: [
    // 09:00 in GENERIC_TIMEZONE (docker-compose.yml).
    node(
      'c2a1d7e3-0000-4000-8000-000000000001',
      'Every morning',
      'n8n-nodes-base.scheduleTrigger',
      1.2,
      [0, 0],
      { rule: { interval: [{ field: 'days', triggerAtHour: 9 }] } },
    ),
    // For a summary on demand: the editor's "Execute workflow", or
    // `n8n execute --id=ffDailySummary01` (the CLI can't start from a schedule).
    node(
      'c2a1d7e3-0000-4000-8000-000000000005',
      'Run now',
      'n8n-nodes-base.manualTrigger',
      1,
      [0, 160],
      {},
    ),
    node(
      'c2a1d7e3-0000-4000-8000-000000000002',
      'Read flags',
      'n8n-nodes-base.httpRequest',
      4.2,
      [220, 0],
      {
        url: '={{ $env.FF_API_URL }}/v1/flags',
        sendHeaders: true,
        headerParameters: {
          parameters: [{ name: 'Authorization', value: '=Bearer {{ $env.FF_ADMIN_KEY }}' }],
        },
        options: {},
      },
    ),
    node(
      'c2a1d7e3-0000-4000-8000-000000000003',
      'Summarize rollouts',
      'n8n-nodes-base.code',
      2,
      [440, 0],
      { jsCode: code('daily-summary.js') },
    ),
    discord('c2a1d7e3-0000-4000-8000-000000000004', [660, 0]),
  ],
  connections: {
    'Every morning': { main: [[{ node: 'Read flags', type: 'main', index: 0 }]] },
    'Run now': { main: [[{ node: 'Read flags', type: 'main', index: 0 }]] },
    'Read flags': { main: [[{ node: 'Summarize rollouts', type: 'main', index: 0 }]] },
    'Summarize rollouts': { main: [[{ node: 'Post to Discord', type: 'main', index: 0 }]] },
  },
};

export const WORKFLOWS = {
  'flag-change-to-discord.json': flagChange,
  'daily-rollout-summary.json': dailySummary,
};

const text = (workflow) => `${JSON.stringify(workflow, null, 2)}\n`;

if (process.argv[1] === import.meta.filename) {
  const check = process.argv.includes('--check');
  let stale = false;
  for (const [file, workflow] of Object.entries(WORKFLOWS)) {
    const path = join(here, 'workflows', file);
    if (check) {
      let current = '';
      try {
        current = readFileSync(path, 'utf8');
      } catch {
        // missing counts as out of date
      }
      if (current !== text(workflow)) {
        console.error(`${file} is out of date: run node tools/n8n/workflows.mjs`);
        stale = true;
      }
    } else {
      writeFileSync(path, text(workflow));
      console.log(`wrote workflows/${file}`);
    }
  }
  if (stale) process.exit(1);
}
