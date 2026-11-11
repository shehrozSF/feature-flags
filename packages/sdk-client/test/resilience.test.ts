// @vitest-environment node
// Real fetch and WebSocket over a real network (Node), not the simulated browser:
// SDK → fault proxy → fake API, the same spec §10 scenarios as the server SDK.
import { startFakeApi, startFaultProxy, type FakeApi, type FaultProxy } from '@ff/fault-proxy';
import type { Flag, Ruleset } from '@ff/eval-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserClient, type BrowserClient, type BrowserClientOptions } from '../src/index';

const PK = { userId: 'u1', country: 'PK' };
const onOff = [
  { key: 'on', value: true },
  { key: 'off', value: false },
];
const flag = (key: string, enabled: boolean): Flag => ({
  key,
  enabled,
  variants: onOff,
  offVariant: 'off',
  rules: [],
  defaultServe: { variant: 'on' },
  salt: key,
  version: 1,
});
const ruleset = (projectVersion: number, promoOn = true): Ruleset => ({
  projectVersion,
  flags: { 'promo-banner': flag('promo-banner', promoOn) },
});

/** localStorage stand-in for Node: survives across clients like a real page reload. */
function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key: string) => items.get(key) ?? null,
    key: (index: number) => [...items.keys()][index] ?? null,
    removeItem: (key: string) => void items.delete(key),
    setItem: (key: string, value: string) => void items.set(key, value),
  };
}

let api: FakeApi | undefined;
let proxy: FaultProxy | undefined;
const clients: BrowserClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await proxy?.close();
  proxy = undefined;
  await api?.close();
  api = undefined;
});

async function setup(options: Partial<BrowserClientOptions> = {}) {
  api ??= await startFakeApi({ ruleset: ruleset(1) });
  proxy ??= await startFaultProxy({ target: api.url });
  const changes = vi.fn();
  const client = createBrowserClient({
    clientKey: api.keys.client,
    baseUrl: proxy.url,
    context: PK,
    storage: memoryStorage(),
    document: null,
    backoff: { baseMs: 20, capMs: 100 },
    random: () => 1,
    pollIntervalMs: 50,
    ...options,
  });
  clients.push(client);
  client.on('change', changes);
  return { api, proxy, client, changes };
}

const connected = () => vi.waitFor(() => expect(api!.sockets()).toBe(1));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('browser SDK resilience (spec §10)', () => {
  it('1. API down: cached results are served', async () => {
    const { proxy, client, changes } = await setup();
    await client.ready();
    await connected();
    changes.mockClear();

    proxy.set({ kind: 'down' });
    await sleep(300); // failed reconnects and polls

    expect(client.variation('promo-banner', false)).toBe(true);
    expect(changes).not.toHaveBeenCalled();
  });

  it('2. API recovers: reconnects and picks up changes made during the outage', async () => {
    const { api, proxy, client } = await setup();
    await client.ready();
    await connected();
    proxy.set({ kind: 'down' });
    await sleep(100);

    api.publish(ruleset(2, false));
    proxy.set({ kind: 'pass' });
    await vi.waitFor(() => expect(client.variation('promo-banner', true)).toBe(false), {
      timeout: 2000,
    });
    await connected();
  });

  it('3. slow first evaluate: ready resolves at timeoutMs with fallbacks, then catches up', async () => {
    api = await startFakeApi({ ruleset: ruleset(1) });
    proxy = await startFaultProxy({ target: api.url });
    proxy.set({ kind: 'delay', ms: 1500 });
    const { client } = await setup({ timeoutMs: 200 });

    const started = Date.now();
    await client.ready();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(client.variationDetail('promo-banner', false)).toMatchObject({
      value: false,
      reason: 'ERROR',
    });

    proxy.set({ kind: 'pass' });
    await vi.waitFor(() => expect(client.variation('promo-banner', false)).toBe(true), {
      timeout: 3000,
    });
  });

  it('4. malformed response: previous results kept', async () => {
    const { api, proxy, client } = await setup();
    await client.ready();
    await connected();

    proxy.set({ kind: 'corrupt' }); // the socket works; evaluate answers come back broken
    api.publish(ruleset(2, false));
    await sleep(500); // debounce + evaluate + a retry or two
    expect(client.variation('promo-banner', false)).toBe(true);

    proxy.set({ kind: 'pass' });
    api.publish(ruleset(3, false));
    await vi.waitFor(() => expect(client.variation('promo-banner', true)).toBe(false), {
      timeout: 2000,
    });
  });

  it('a reload with the API down serves the stored results', async () => {
    const storage = memoryStorage();
    const first = await setup({ storage });
    await first.client.ready();
    first.client.close(); // the page goes away

    first.proxy.set({ kind: 'down' });
    const { client } = await setup({ storage }); // the page is loaded again
    const started = Date.now();
    await client.ready();
    expect(Date.now() - started).toBeLessThan(100); // from storage, not after a timeout
    expect(client.variation('promo-banner', false)).toBe(true);
  });
});
