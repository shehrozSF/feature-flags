import { startFakeApi, startFaultProxy, type FakeApi, type FaultProxy } from '@ff/fault-proxy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServerClient, type ServerClient, type ServerClientOptions } from '../src/index';
import { ruleset, silentLogger } from './fixtures';

// The four resilience scenarios of spec §10, over a real network: SDK → fault
// proxy → fake API. The proxy breaks the connection on purpose, so the SDK's real
// error handling runs (not a mocked fetch that "fails").
const PK = { userId: 'u1', country: 'PK' };
const fast = { baseMs: 20, capMs: 100 };

let api: FakeApi | undefined;
let proxy: FaultProxy | undefined;
let client: ServerClient | undefined;
afterEach(async () => {
  client?.close();
  client = undefined;
  await proxy?.close();
  proxy = undefined;
  await api?.close();
  api = undefined;
});

async function setup(options: Partial<ServerClientOptions> = {}) {
  api = await startFakeApi({ ruleset: ruleset(1) });
  proxy = await startFaultProxy({ target: api.url });
  const { warnings, logger } = silentLogger();
  const changes: number[] = [];
  client = await createServerClient({
    serverKey: api.keys.server,
    baseUrl: proxy.url,
    mode: 'streaming',
    backoff: fast,
    pollIntervalMs: 50,
    logger,
    ...options,
  });
  client.on('change', (version) => changes.push(version));
  return { api, proxy, client, warnings, changes };
}

const connected = () => vi.waitFor(() => expect(api!.sockets()).toBe(1));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('server SDK resilience (spec §10)', () => {
  it('1. API down: cached values are served', async () => {
    const { proxy, client, changes } = await setup();
    await connected();

    proxy.set({ kind: 'down' });
    await sleep(300); // several failed reconnects and polls

    expect(client.variation('pk-local-payments', PK, false)).toBe(true);
    expect(client.variation('promo-banner', PK, false)).toBe(true);
    expect(client.version()).toBe(1);
    expect(changes).toEqual([]);
  });

  it('2. API recovers: reconnects and picks up changes made during the outage', async () => {
    const { api, proxy, client, changes } = await setup();
    await connected();
    proxy.set({ kind: 'down' });
    await sleep(100);

    api.publish(ruleset(2, false)); // a change nobody connected could hear
    proxy.set({ kind: 'pass' });

    await vi.waitFor(() => expect(client.variation('promo-banner', PK, true)).toBe(false));
    expect(changes).toEqual([2]);
    await connected(); // and the stream is back
  });

  it('3. slow first fetch: init resolves at timeoutMs with fallbacks, then catches up', async () => {
    api = await startFakeApi({ ruleset: ruleset(1) });
    proxy = await startFaultProxy({ target: api.url });
    proxy.set({ kind: 'delay', ms: 1500 });

    const started = Date.now();
    client = await createServerClient({
      serverKey: api.keys.server,
      baseUrl: proxy.url,
      mode: 'streaming',
      timeoutMs: 200,
      backoff: fast,
      logger: silentLogger().logger,
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(client.variationDetail('pk-local-payments', PK, false)).toMatchObject({
      value: false,
      reason: 'ERROR',
    });

    proxy.set({ kind: 'pass' });
    await vi.waitFor(() => expect(client!.variation('pk-local-payments', PK, false)).toBe(true), {
      timeout: 3000,
    });
  });

  it('4. malformed response: last good rules kept', async () => {
    const { api, proxy, client, warnings } = await setup();
    await connected();

    proxy.set({ kind: 'corrupt' }); // the socket still works; rules come back broken
    api.publish(ruleset(2, false));
    await vi.waitFor(() => expect(warnings.join('\n')).toMatch(/invalid ruleset/));
    expect(client.version()).toBe(1);
    expect(client.variation('promo-banner', PK, false)).toBe(true);

    proxy.set({ kind: 'pass' });
    api.publish(ruleset(3, false));
    await vi.waitFor(() => expect(client.version()).toBe(3));
  });

  it('polling mode survives the same outage', async () => {
    // random → 1: each failed attempt waits the full backoff ceiling, so recovery
    // time depends only on the configured backoff (no lucky short jitter).
    const { api, proxy, client } = await setup({
      mode: 'polling',
      cacheTtlMs: 20,
      random: () => 1,
    });
    proxy.set({ kind: 'down' });
    for (let i = 0; i < 5; i++) {
      await sleep(30);
      expect(client.variation('promo-banner', PK, false)).toBe(true); // last good, every call
    }

    api.publish(ruleset(2, false));
    proxy.set({ kind: 'pass' });
    // With backoff capped at 100 ms, recovery must be quick: well under 500 ms.
    await vi.waitFor(
      () => {
        expect(client.variation('promo-banner', PK, true)).toBe(false); // each call may revalidate
      },
      { timeout: 500 },
    );
  });
});
