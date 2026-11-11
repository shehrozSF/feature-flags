import { parseStreamMessage, RulesetSchema } from '@ff/contracts';
import type { Ruleset } from '@ff/eval-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeApi, type FakeApi } from '../src/fake-api';
import { startFaultProxy, type FaultProxy } from '../src/proxy';

// The fault proxy sits between an SDK and the (fake) API and breaks the network
// on purpose: real sockets fail, so the SDK's real error handling runs.
const ruleset: Ruleset = { projectVersion: 1, flags: {} };

let api: FakeApi;
let proxy: FaultProxy;
beforeEach(async () => {
  api = await startFakeApi({ ruleset });
  proxy = await startFaultProxy({ target: api.url });
});
afterEach(async () => {
  await proxy.close();
  await api.close();
});

const rules = () =>
  fetch(`${proxy.url}/v1/sdk/rules`, { headers: { authorization: `Bearer ${api.keys.server}` } });

function openStream() {
  const ws = new WebSocket(
    `${proxy.url.replace('http', 'ws')}/v1/client/stream?key=${api.keys.client}`,
  );
  const messages: string[] = [];
  let closed = false;
  ws.addEventListener('message', (e) => messages.push(String(e.data)));
  ws.addEventListener('close', () => (closed = true));
  const opened = new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('socket error')));
  });
  return { ws, messages, opened, closed: () => closed };
}

const until = async (check: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('fault proxy', () => {
  it('pass forwards requests and sockets', async () => {
    const res = await rules();
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('W/"1"');
    expect(RulesetSchema.safeParse(await res.json()).success).toBe(true);

    const s = openStream();
    await s.opened;
    await until(() => s.messages.length > 0);
    expect(parseStreamMessage(s.messages[0]!)).toEqual({ type: 'hello', version: 1 });
    s.ws.send('ping');
    await until(() => s.messages.includes('pong'));
    expect(proxy.connections()).toBeGreaterThanOrEqual(1);
    s.ws.close();
  });

  it('down fails requests with a network error and drops open sockets', async () => {
    const s = openStream();
    await s.opened;

    proxy.set({ kind: 'down' });
    await until(() => s.closed());
    await until(() => proxy.connections() === 0);
    await expect(rules()).rejects.toThrow(); // a network error, not an HTTP status
    await expect(openStream().opened).rejects.toThrow();
  });

  it('delay holds a request for at least the delay', async () => {
    proxy.set({ kind: 'delay', ms: 300 });
    const started = Date.now();
    expect((await rules()).status).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
  });

  it('corrupt keeps the status but breaks the body', async () => {
    proxy.set({ kind: 'corrupt' });
    const res = await rules();
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('W/"1"');
    const body: unknown = await res.json(); // still valid JSON…
    expect(RulesetSchema.safeParse(body).success).toBe(false); // …but not a ruleset
  });

  it('back to pass works again', async () => {
    proxy.set({ kind: 'down' });
    await expect(rules()).rejects.toThrow();
    proxy.set({ kind: 'pass' });
    expect((await rules()).status).toBe(200);
  });
});
