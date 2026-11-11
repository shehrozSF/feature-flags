#!/usr/bin/env node
// Latency of POST /v1/client/evaluate against a deployed API, as a browser sees it:
//   corepack pnpm measure:evaluate <baseUrl> [--samples 50]
// It creates its own sandbox (one of the 5 an hour per IP) and sends `samples`
// evaluates one after another. The first is reported apart: it finds the
// project's hub cold and loads it from Postgres (which may also be waking up).
// Evaluate is limited to 60 a minute per project, so keep samples under that.
import { createSandbox, parseArgs, summarize, usage } from './lib.mjs';

const options = parseArgs(process.argv.slice(2), { samples: 50 });
if (options.bad) usage('evaluate.mjs', options.bad, '[--samples 50]');
const { base, samples } = options;

const keys = await createSandbox(base);
const headers = { authorization: `Bearer ${keys.client}`, 'content-type': 'application/json' };
const body = JSON.stringify({ context: { userId: 'measure', country: 'PK', plan: 'pro' } });

const times = [];
for (let i = 0; i < samples; i++) {
  const start = performance.now();
  const res = await fetch(`${base}/v1/client/evaluate`, { method: 'POST', headers, body });
  await res.text();
  if (res.status === 429) {
    console.error(`stopped at sample ${i + 1}: rate limited (60 a minute per project)`);
    break;
  }
  if (res.status !== 200) throw new Error(`evaluate answered ${res.status}`);
  times.push(performance.now() - start);
}

const [first, ...warm] = times;
const s = summarize(warm);
console.log(`Evaluate: ${base}, ${new Date().toISOString()}, ${times.length} requests`);
console.log(`| first (cold hub) | ${Math.round(first)} ms |`);
console.log('| warm | n | p50 | p95 | max | mean |');
console.log(`| | ${s.n} | ${s.p50} ms | ${s.p95} ms | ${s.max} ms | ${s.mean} ms |`);
