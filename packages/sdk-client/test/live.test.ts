import { fakeSockets, type FakeSocket } from '@ff/fault-proxy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserClient, type BrowserClient } from '../src/index';
import { json, manualFetch, results } from './fixtures';

// Live updates (spec §8.2): a WebSocket says when rules changed; the SDK re-evaluates
// after a 250 ms debounce. While the socket is down it polls every 30 s, and a hidden
// tab closes the socket and stops polling to save Durable Object quota.
const KEY = 'ff_client_3f2a6c1e-8b4d-4e7a-9c2f-1a2b3c4d5e6f_' + 'A'.repeat(43);
const PK = { userId: 'u1', country: 'PK' };

/** A document whose visibility the test controls. */
class FakeDocument extends EventTarget {
  hidden = false;
  setHidden(hidden: boolean) {
    this.hidden = hidden;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

let client: BrowserClient | undefined;
afterEach(() => {
  client?.close();
  client = undefined;
  vi.useRealTimers();
});

async function start(onCreate?: (s: FakeSocket) => void) {
  vi.useFakeTimers();
  const sockets = fakeSockets(onCreate);
  const doc = new FakeDocument();
  const f = manualFetch();
  client = createBrowserClient({
    clientKey: KEY,
    baseUrl: 'http://api',
    context: PK,
    fetch: f.fetch,
    storage: null,
    webSocket: (url) => sockets.webSocket(url, {}),
    document: doc,
    random: () => 1, // no jitter: each backoff wait is exactly its ceiling
    backoff: { baseMs: 50, capMs: 400 },
  });
  f.calls[0]!.respond(json(results(1)));
  await vi.advanceTimersByTimeAsync(0);
  /** Answers every evaluate that is waiting, with the given results. */
  const answerAll = async (body = results(1)) => {
    for (const c of f.calls) c.respond(json(body));
    await vi.advanceTimersByTimeAsync(0);
  };
  return { client, sockets: sockets.sockets, doc, calls: f.calls, answerAll };
}

const hello = (s: FakeSocket, version = 1) => {
  s.open();
  s.message(JSON.stringify({ type: 'hello', version }));
};

describe('browser SDK: live updates', () => {
  it('connects to the client stream with the key in the URL', async () => {
    const { sockets } = await start();
    expect(sockets[0]!.url).toBe(`ws://api/v1/client/stream?key=${encodeURIComponent(KEY)}`);
  });

  it('changed triggers one debounced evaluate', async () => {
    const { sockets, calls } = await start();
    const s = sockets[0]!;
    hello(s);

    s.message('{"type":"changed","version":2}');
    await vi.advanceTimersByTimeAsync(100);
    s.message('{"type":"changed","version":2}');
    await vi.advanceTimersByTimeAsync(100);
    s.message('{"type":"changed","version":3}');
    await vi.advanceTimersByTimeAsync(249);
    expect(calls).toHaveLength(1); // still the initial evaluate only
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2); // one evaluate, 250 ms after the last change
  });

  it('an older or equal version is ignored', async () => {
    const { sockets, calls } = await start();
    const s = sockets[0]!;
    hello(s);
    s.message('{"type":"changed","version":1}');
    s.message('{"type":"changed","version":0}');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(1);
  });

  it('keepalive sends ping every 30 s', async () => {
    const { sockets } = await start();
    hello(sockets[0]!);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sockets[0]!.sent).toEqual(['ping']);
  });

  it('socket down: polls every 30 s and reconnects with backoff', async () => {
    // Every socket after the first fails at once.
    const { sockets, calls, answerAll } = await start((s) => {
      if (sockets.length > 0) queueMicrotask(() => s.drop());
    });
    hello(sockets[0]!);
    sockets[0]!.drop();

    await vi.advanceTimersByTimeAsync(29_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2); // polled
    await answerAll();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toHaveLength(3); // polled again
    // Reconnects kept trying, backing off: 50, 100, 200, 400, 400 … not every few ms.
    expect(sockets.length).toBeGreaterThan(100);
    expect(sockets.length).toBeLessThan(160);
  });

  it('hidden tab: socket closed, no polling', async () => {
    const { sockets, calls, doc } = await start();
    hello(sockets[0]!);
    doc.setHidden(true);
    expect(sockets[0]!.closedByClient).toBe(true);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toHaveLength(1);
    expect(sockets).toHaveLength(1);
  });

  it('visible again: evaluates and reconnects', async () => {
    const { sockets, calls, doc } = await start();
    hello(sockets[0]!);
    doc.setHidden(true);
    doc.setHidden(false);

    expect(calls).toHaveLength(2);
    expect(sockets).toHaveLength(2);
  });

  it('close stops sockets, timers and listeners', async () => {
    const { client, sockets, calls, doc } = await start();
    hello(sockets[0]!);
    client.close();

    expect(sockets[0]!.closedByClient).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    doc.setHidden(true);
    doc.setHidden(false); // no longer listening
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toHaveLength(1);
    expect(sockets).toHaveLength(1);
  });
});
