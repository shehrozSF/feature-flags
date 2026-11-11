import { fakeSockets, startFakeApi, type FakeApi } from '@ff/fault-proxy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServerClient, type ServerClient } from '../src/index';
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

  /** A streaming client whose fetches the test scripts one by one. */
  const scripted = async (responses: Parameters<typeof scriptedFetch>[0]) => {
    vi.useFakeTimers();
    const sockets = fakeSockets();
    const { fetch, calls } = scriptedFetch(responses);
    client = await createServerClient({
      serverKey: 'k',
      baseUrl: 'http://api',
      mode: 'streaming',
      fetch,
      webSocket: sockets.webSocket,
      backoff: fast,
      random: () => 1,
      logger: silentLogger().logger,
    });
    const s = sockets.sockets[0]!;
    s.open();
    s.message('{"type":"hello","version":1}');
    return { s, calls };
  };

  it('a change that arrives during a fetch is not lost (final review I1)', async () => {
    let releaseV5!: (response: Response) => void;
    const { s, calls } = await scripted([
      () => json(ruleset(1)),
      () => new Promise<Response>((resolve) => (releaseV5 = resolve)),
      () => json(ruleset(6, false)),
    ]);
    s.message('{"type":"changed","version":5}'); // fetch #2 starts and is held
    s.message('{"type":"changed","version":6}'); // arrives while #2 is in flight
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(2);

    releaseV5(json(ruleset(5)));
    await vi.advanceTimersByTimeAsync(200);
    expect(client!.version()).toBe(6); // caught up without another change
  });

  it('a change whose fetch fails is fetched again (final review I1)', async () => {
    const { s } = await scripted([
      () => json(ruleset(1)),
      () => new Response(null, { status: 503, headers: { 'retry-after': '1' } }),
      () => json(ruleset(6, false)),
    ]);
    s.message('{"type":"changed","version":6}');
    await vi.advanceTimersByTimeAsync(0);
    expect(client!.version()).toBe(1); // the fetch failed

    await vi.advanceTimersByTimeAsync(1_100); // Retry-After, then again
    expect(client!.version()).toBe(6);
  });

  it('polling while disconnected waits for Retry-After after a 429', async () => {
    // Phase 4 review: catch-up respected Retry-After, but the fallback polling didn't,
    // so a rate-limited or overloaded API kept getting a request every 30 s.
    const { s, calls } = await scripted([
      () => json(ruleset(1)),
      () => json({ status: 429 }, { status: 429, headers: { 'retry-after': '120' } }),
      ...Array.from({ length: 10 }, () => () => json(ruleset(1))),
    ]);
    const before = calls.length;
    s.drop(); // socket down: poll every 30 s
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls.length).toBe(before + 1); // answered 429, Retry-After 120 s

    await vi.advanceTimersByTimeAsync(119_000); // polls due at 60, 90, 120 s: all inside it
    expect(calls.length).toBe(before + 1);
    await vi.advanceTimersByTimeAsync(1_000); // the poll at 150 s: Retry-After is over
    expect(calls.length).toBe(before + 2);
  });

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
    s.message('pong'); // unanswered pings close the socket (the dead-socket test below)
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

    // A hello alone doesn't reset the backoff: a hub that says hello and then
    // drops would otherwise get reconnects within 0-1 s forever (Phase 4 review).
    healthy = true;
    await vi.advanceTimersByTimeAsync(400);
    const flaky = sockets.at(-1)!;
    flaky.message('{"type":"hello","version":1}');
    let before = sockets.length;
    flaky.drop();
    await vi.advanceTimersByTimeAsync(399);
    expect(sockets.length).toBe(before); // still at the 400 ms ceiling
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets.length).toBe(before + 1);

    // Staying open for a keepalive interval does reset it to the first step.
    const good = sockets.at(-1)!;
    good.message('{"type":"hello","version":1}');
    await vi.advanceTimersByTimeAsync(30_000);
    good.message('pong'); // answers the keepalive ping
    before = sockets.length;
    good.drop();
    await vi.advanceTimersByTimeAsync(49);
    expect(sockets.length).toBe(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets.length).toBe(before + 1);
  });

  it('a socket that stops answering pings is closed with 4000 and reopened', async () => {
    // A silently dead connection (laptop asleep, NAT dropped it) never fires close
    // until TCP gives up, minutes later; meanwhile no changes arrive.
    const { sockets } = await start();
    const s = sockets[0]!;
    s.open();
    s.message('{"type":"hello","version":1}');

    await vi.advanceTimersByTimeAsync(30_000);
    expect(s.sent).toEqual(['ping']);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(s.closedByClient).toBe(false);
    await vi.advanceTimersByTimeAsync(1); // 10 s without a pong
    expect(s.closedByClient).toBe(true);
    expect(s.closeCode).toBe(4000);
    await vi.advanceTimersByTimeAsync(20); // first backoff step: it stayed open 30 s
    expect(sockets).toHaveLength(2);
  });

  it('a pong in time keeps the socket', async () => {
    const { sockets } = await start();
    const s = sockets[0]!;
    s.open();
    s.message('{"type":"hello","version":1}');
    await vi.advanceTimersByTimeAsync(35_000); // ping at 30 s
    s.message('pong');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(s.closedByClient).toBe(false);
    expect(sockets).toHaveLength(1);
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
