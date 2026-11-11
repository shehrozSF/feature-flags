#!/usr/bin/env node
// How fast a flag change reaches clients, measured against a deployed API:
//   corepack pnpm measure:propagation <baseUrl> [--samples 30] [--sockets 10]
// It creates its own sandbox (one of the 5 an hour per IP), opens `sockets` client
// streams plus one real browser SDK (running in Node), then flips promo-banner
// `samples` times, 3 s apart, timing from sending the PATCH until:
//   - the PATCH is answered (the write is committed and pushed to the hub);
//   - every socket has received `changed`;
//   - the browser SDK reports the new value (its 250 ms debounce + an evaluate).
// Runs with tsx: the browser SDK is imported from its TypeScript source.
import { createBrowserClient } from '../../packages/sdk-client/src/index.ts';
import { createSandbox, parseArgs, summarize, usage } from './lib.mjs';

const GAP_MS = 3_000;
const WAIT_MS = 10_000;
const FLAG = 'promo-banner'; // seeded: enabled, serves true; disabled, serves false

const options = parseArgs(process.argv.slice(2), { samples: 30, sockets: 10 });
if (options.bad) usage('propagation.mjs', options.bad, '[--samples 30] [--sockets 10]');
const { base, samples, sockets: socketCount } = options;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const within = (promise, what) =>
  Promise.race([
    promise,
    sleep(WAIT_MS).then(() => {
      throw new Error(`${what}: nothing within ${WAIT_MS / 1000} s`);
    }),
  ]);

const keys = await createSandbox(base);
const streamUrl = `${base.replace(/^http/, 'ws')}/v1/client/stream?key=${encodeURIComponent(keys.client)}`;

/** A raw client stream; `next()` resolves with the arrival time of the next `changed`. */
function openSocket() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(streamUrl);
    const waiting = [];
    const socket = {
      ws,
      next: () => new Promise((r) => waiting.push(r)),
    };
    ws.addEventListener('message', (event) => {
      if (event.data === 'pong' || typeof event.data !== 'string') return;
      const message = JSON.parse(event.data);
      if (message.type === 'hello') resolve(socket);
      if (message.type === 'changed') {
        const at = performance.now();
        for (const done of waiting.splice(0)) done(at);
      }
    });
    ws.addEventListener('close', (event) => reject(new Error(`socket closed (${event.code})`)));
  });
}

const sockets = await within(
  Promise.all(Array.from({ length: socketCount }, openSocket)),
  'opening the sockets',
);
const keepalive = setInterval(() => sockets.forEach((s) => s.ws.send('ping')), 25_000);

const client = createBrowserClient({
  clientKey: keys.client,
  baseUrl: base,
  context: { userId: 'measure' },
  storage: null,
  document: null,
});
await within(client.ready(), 'the browser SDK starting');

const admin = { authorization: `Bearer ${keys.admin}`, 'content-type': 'application/json' };
let etag = (await fetch(`${base}/v1/flags/${FLAG}`, { headers: admin })).headers.get('etag');
let enabled = true;
const write = [];
const socketMs = [];
const sdkMs = [];
let delayed = 0;

for (let i = 0; i < samples; i++) {
  enabled = !enabled;
  const arrivals = sockets.map((s) => s.next());
  const sdkSees = new Promise((resolve) => {
    const off = client.on('change', () => {
      if (client.variation(FLAG, !enabled) === enabled) {
        off();
        resolve(performance.now());
      }
    });
  });

  const start = performance.now();
  const res = await fetch(`${base}/v1/flags/${FLAG}`, {
    method: 'PATCH',
    headers: { ...admin, 'if-match': etag },
    body: JSON.stringify({ enabled }),
  });
  if (res.status !== 200) throw new Error(`PATCH answered ${res.status}`);
  write.push(performance.now() - start);
  etag = res.headers.get('etag');
  if (res.headers.get('x-propagation') === 'delayed') delayed++;

  for (const at of await within(Promise.all(arrivals), `sample ${i + 1}: changed`)) {
    socketMs.push(at - start);
  }
  sdkMs.push((await within(sdkSees, `sample ${i + 1}: the browser SDK`)) - start);
  process.stdout.write(`\rsample ${i + 1}/${samples}`);
  await sleep(GAP_MS);
}

clearInterval(keepalive);
client.close();
for (const s of sockets) s.ws.close();

const rows = [
  ['PATCH answered (write + push to the hub)', summarize(write)],
  [`changed received, ${socketCount} sockets`, summarize(socketMs)],
  ['new value in the browser SDK', summarize(sdkMs)],
];
console.log(`\n\nPropagation: ${base}, ${new Date().toISOString()}, ${samples} flips`);
console.log('| measured from sending the PATCH | n | p50 | p95 | max | mean |');
console.log('|---|---|---|---|---|---|');
for (const [name, s] of rows) {
  console.log(`| ${name} | ${s.n} | ${s.p50} ms | ${s.p95} ms | ${s.max} ms | ${s.mean} ms |`);
}
if (delayed > 0) console.log(`(${delayed} writes answered x-propagation: delayed)`);
