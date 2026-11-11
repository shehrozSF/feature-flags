import { startFakeApi, type FakeApi } from '@ff/fault-proxy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServerClient, type ServerClient } from '../src/index';
import { fakeSockets } from './fake-socket';
import { json, ruleset, scriptedFetch, silentLogger } from './fixtures';

// Streaming mode (spec §8.1, protocol §6.3): a WebSocket tells the SDK when rules
// changed; the SDK then fetches them with If-None-Match. While the socket is down
// it reconnects with backoff and polls.
const PK = { userId: 'u1', country: 'PK' };
const fast = { baseMs: 20, capMs: 100 };

let api: FakeApi | undefined;
let client: ServerClient | undefined;
afterEach(async () => {
  client?.close();
  client = undefined;
  await api?.close();
  api = undefined;
  vi.useRealTimers();
});

const rulesRequests = () => api!.requests.filter((r) => r.path === '/v1/sdk/rules');
const streamUpgrades = () => api!.requests.filter((r) => r.path === '/v1/sdk/stream');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const streaming = async (extra: object = {}) => {
  api = await startFakeApi({ ruleset: ruleset(1) });
  client = await createServerClient({
    serverKey: api.keys.server,
    baseUrl: api.url,
    mode: 'streaming',
    backoff: fast,
    logger: silentLogger().logger,
    ...extra,
  });
  return client;
};

describe('server SDK: streaming over a real socket', () => {
  it('the stream sends the server key in the Authorization header', async () => {
    await streaming();
    await vi.waitFor(() => expect(api!.sockets()).toBe(1));
    expect(streamUpgrades()[0]!.headers.authorization).toBe(`Bearer ${api!.keys.server}`);
  });

  it('changed triggers a conditional fetch and fires change', async () => {
    const c = await streaming();
    await vi.waitFor(() => expect(api!.sockets()).toBe(1));
    const seen: number[] = [];
    c.on('change', (version) => seen.push(version));

    api!.publish(ruleset(2, false));
    await vi.waitFor(() => expect(seen).toEqual([2]));
    expect(c.variation('promo-banner', PK, true)).toBe(false);
    expect(rulesRequests().at(-1)!.headers['if-none-match']).toBe('W/"1"');
  });

  it('hello with the held version fetches nothing', async () => {
    await streaming();
    await vi.waitFor(() => expect(api!.sockets()).toBe(1));
    await sleep(50);
    expect(rulesRequests()).toHaveLength(1); // only the initial load
  });

  it('a changed for an older version is ignored', async () => {
    const c = await streaming();
    await vi.waitFor(() => expect(api!.sockets()).toBe(1));
    api!.publish(ruleset(0));
    await sleep(50);
    expect(rulesRequests()).toHaveLength(1);
    expect(c.version()).toBe(1);
  });

  it('reconnects after the socket drops', async () => {
    const c = await streaming();
    await vi.waitFor(() => expect(api!.sockets()).toBe(1));
    api!.disconnect();
    await vi.waitFor(() => expect(streamUpgrades()).toHaveLength(2));
    await vi.waitFor(() => expect(api!.sockets()).toBe(1));

    api!.publish(ruleset(2, false));
    await vi.waitFor(() => expect(c.variation('promo-banner', PK, true)).toBe(false));
  });

  it('polls while disconnected', async () => {
    // A socket that can never connect (nothing listens on port 1).
    const c = await streaming({
      pollIntervalMs: 50,
      webSocket: () => new WebSocket('ws://127.0.0.1:1'),
    });
    api!.publish(ruleset(2, false)); // no socket to hear it
    await vi.waitFor(() => expect(c.version()).toBe(2));
  });
});

describe('server SDK: streaming timing (in-memory sockets)', () => {
  const start = async (onCreate?: Parameters<typeof fakeSockets>[0], backoff = fast) => {
    vi.useFakeTimers();
    const sockets = fakeSockets(onCreate);
    const { fetch } = scriptedFetch(Array.from({ length: 50 }, () => () => json(ruleset(1))));
    client = await createServerClient({
      serverKey: 'k',
      baseUrl: 'http://api',
      mode: 'streaming',
      fetch,
      webSocket: sockets.webSocket,
      backoff,
      random: () => 1, // no jitter: each wait is exactly the ceiling
      logger: silentLogger().logger,
    });
    return sockets;
  };

  it('keepalive sends ping every 30 s', async () => {
    const { sockets } = await start();
    const s = sockets[0]!;
    expect(s.url).toBe('ws://api/v1/sdk/stream');
    s.open();
    s.message('{"type":"hello","version":1}');

    await vi.advanceTimersByTimeAsync(29_999);
    expect(s.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.sent).toEqual(['ping']);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s.sent).toEqual(['ping', 'ping']);
  });

  it('flapping connections back off instead of storming', async () => {
    let healthy = false;
    const { sockets } = await start(
      (s) => {
        // Accepts, then drops before saying hello: unless healthy.
        queueMicrotask(() => {
          s.open();
          if (!healthy) s.drop();
        });
      },
      { baseMs: 50, capMs: 400 },
    );

    // Waits 50, 100, 200, 400, 400, 400, 400 → by 1950 ms: 1 + 7 connections.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sockets.length).toBe(8);

    // A connection that says hello resets the backoff to the first step.
    healthy = true;
    await vi.advanceTimersByTimeAsync(400);
    const good = sockets.at(-1)!;
    good.message('{"type":"hello","version":1}');
    const before = sockets.length;
    good.drop();
    await vi.advanceTimersByTimeAsync(49);
    expect(sockets.length).toBe(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets.length).toBe(before + 1);
  });

  it('close during a reconnect wait stops everything', async () => {
    const { sockets } = await start();
    sockets[0]!.open();
    sockets[0]!.drop(); // reconnect scheduled
    client!.close();

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
  });

  it('close shuts the open socket', async () => {
    const { sockets } = await start();
    sockets[0]!.open();
    client!.close();
    expect(sockets[0]!.closedByClient).toBe(true);
  });
});
