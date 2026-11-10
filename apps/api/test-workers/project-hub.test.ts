import type { Ruleset } from '@ff/eval-core';
import { evictDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { ProjectSnapshot } from '../src/domain/ports';
import { PROJECT_DELETED, type HubClient } from '../src/hub/hub-client';

const CLIENT_HASH = 'c'.repeat(64);
const SERVER_HASH = 'd'.repeat(64);

const ruleset = (projectVersion: number): Ruleset => ({
  projectVersion,
  flags: {
    banner: {
      key: 'banner',
      enabled: true,
      variants: [
        { key: 'on', value: true },
        { key: 'off', value: false },
      ],
      offVariant: 'off',
      rules: [],
      defaultServe: { variant: 'on' },
      salt: 'salt-1',
      version: projectVersion,
    },
  },
});

const snap = (projectVersion: number): ProjectSnapshot => ({
  ruleset: ruleset(projectVersion),
  keys: [
    { kind: 'client', hashHex: CLIENT_HASH },
    { kind: 'server', hashHex: SERVER_HASH },
  ],
});

// Cloudflare's typed stub (DurableObjectStub<ProjectHub>) maps every RPC return type
// recursively, and Ruleset's nested JSON makes that too deep for tsc (TS2589). The
// Worker talks to the hub through HubClient anyway, so type the stub the same way.
type HubStub = DurableObjectStub & HubClient;

// A fresh hub per test: a new name gives a new Durable Object with empty storage.
const newHub = () =>
  env.PROJECT_HUB.get(env.PROJECT_HUB.idFromName(crypto.randomUUID())) as unknown as HubStub;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Opens a WebSocket to the hub and queues what it receives, so tests can await messages in order. */
async function connect(hub: ReturnType<typeof newHub>) {
  const res = await hub.fetch('http://hub/', { headers: { Upgrade: 'websocket' } });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  const inbox: string[] = [];
  const waiting: ((message: string) => void)[] = [];
  let closeCode: number | undefined;
  ws.addEventListener('message', (e) => {
    const message = typeof e.data === 'string' ? e.data : '<binary>';
    const waiter = waiting.shift();
    if (waiter) waiter(message);
    else inbox.push(message);
  });
  ws.addEventListener('close', (e) => {
    closeCode = e.code;
  });
  ws.accept();
  return {
    ws,
    closeCode: () => closeCode,
    /** The next message, or a failure after 2 s (so a missing message can't hang the run). */
    next: (): Promise<string> =>
      inbox.length > 0
        ? Promise.resolve(inbox.shift()!)
        : Promise.race([
            new Promise<string>((resolve) => waiting.push(resolve)),
            sleep(2000).then(() => Promise.reject(new Error('no message within 2 s'))),
          ]),
  };
}

const json = (message: string): unknown => JSON.parse(message);

describe('ProjectHub reads and updates', () => {
  it('starts cold', async () => {
    expect(await newHub().read('client', 'aa')).toEqual({ status: 'cold' });
  });

  it('serves the ruleset after an update', async () => {
    const hub = newHub();
    expect(await hub.update(snap(1))).toEqual({ applied: true, version: 1 });
    const read = await hub.read('client', CLIENT_HASH);
    expect(read).toMatchObject({ status: 'ok', ruleset: ruleset(1) });
    expect(read.status === 'ok' && typeof read.loadedAt).toBe('number');
  });

  it("denies a key hash it doesn't hold", async () => {
    const hub = newHub();
    await hub.update(snap(1));
    expect(await hub.read('client', 'e'.repeat(64))).toEqual({ status: 'denied' });
    // A real hash, but for a different kind of key: the stored kind must match.
    expect(await hub.read('client', SERVER_HASH)).toEqual({ status: 'denied' });
    expect(await hub.read('admin', CLIENT_HASH)).toEqual({ status: 'denied' });
  });

  it('ignores a snapshot older than the one it has', async () => {
    const hub = newHub();
    await hub.update(snap(3));
    expect(await hub.update(snap(2))).toEqual({ applied: false, version: 3 });
    expect(await hub.read('client', CLIENT_HASH)).toMatchObject({ ruleset: ruleset(3) });
  });

  it('same version refreshes loadedAt without broadcasting', async () => {
    const hub = newHub();
    await hub.update(snap(1));
    const socket = await connect(hub);
    expect(json(await socket.next())).toEqual({ type: 'hello', version: 1 });
    const before = await hub.read('client', CLIENT_HASH);

    await sleep(10);
    expect(await hub.update(snap(1))).toEqual({ applied: false, version: 1 });
    const after = await hub.read('client', CLIENT_HASH);
    expect(before.status === 'ok' && after.status === 'ok').toBe(true);
    if (before.status === 'ok' && after.status === 'ok') {
      expect(after.loadedAt).toBeGreaterThan(before.loadedAt);
    }

    // Nothing was sent for v1 again: the next message is the one for v2.
    await hub.update(snap(2));
    expect(json(await socket.next())).toEqual({ type: 'changed', version: 2 });
  });

  it('survives being evicted from memory', async () => {
    const hub = newHub();
    await hub.update(snap(1));
    // Throws away the in-memory instance; only durable storage is left.
    await evictDurableObject(hub);
    expect(await hub.read('client', CLIENT_HASH)).toMatchObject({
      status: 'ok',
      ruleset: ruleset(1),
    });
  });
});

describe('ProjectHub WebSockets', () => {
  it('greets a new socket with hello and the current version', async () => {
    const cold = await connect(newHub());
    expect(json(await cold.next())).toEqual({ type: 'hello', version: 0 });

    const hub = newHub();
    await hub.update(snap(4));
    const warm = await connect(hub);
    expect(json(await warm.next())).toEqual({ type: 'hello', version: 4 });
  });

  it('broadcasts changed to every socket on a newer version', async () => {
    const hub = newHub();
    await hub.update(snap(1));
    const a = await connect(hub);
    const b = await connect(hub);
    await a.next();
    await b.next();

    await hub.update(snap(1)); // same version: nothing sent
    await hub.update(snap(2));
    expect(json(await a.next())).toEqual({ type: 'changed', version: 2 });
    expect(json(await b.next())).toEqual({ type: 'changed', version: 2 });
  });

  it('answers ping with pong', async () => {
    const socket = await connect(newHub());
    await socket.next(); // hello
    socket.ws.send('ping');
    expect(await socket.next()).toBe('pong');
  });

  it('ignores unexpected socket messages', async () => {
    const hub = newHub();
    const socket = await connect(hub);
    await socket.next(); // hello
    socket.ws.send('{"type":"x"}');
    socket.ws.send('x'.repeat(10_000));
    socket.ws.send('not json at all');

    // Still open, and still told about changes.
    await hub.update(snap(1));
    expect(json(await socket.next())).toEqual({ type: 'changed', version: 1 });
    expect(socket.closeCode()).toBeUndefined();
  });

  it('completes the close handshake when a client disconnects', async () => {
    const socket = await connect(newHub());
    await socket.next(); // hello
    socket.ws.close(1000, 'bye');
    // The hub must answer the close frame; otherwise the client waits ~10 s and
    // ends with 1006 "abnormal closure" (found running the Worker locally).
    for (let i = 0; i < 50 && socket.closeCode() === undefined; i++) await sleep(10);
    expect(socket.closeCode()).toBe(1000);
  });

  it('clear forgets the snapshot and closes every socket', async () => {
    const hub = newHub();
    await hub.update(snap(1));
    const a = await connect(hub);
    const b = await connect(hub);

    await hub.clear();

    expect(await hub.read('client', CLIENT_HASH)).toEqual({ status: 'cold' });
    await evictDurableObject(hub); // gone from storage too, not just memory
    expect(await hub.read('client', CLIENT_HASH)).toEqual({ status: 'cold' });
    for (let i = 0; i < 50 && (a.closeCode() === undefined || b.closeCode() === undefined); i++) {
      await sleep(10);
    }
    expect([a.closeCode(), b.closeCode()]).toEqual([PROJECT_DELETED, PROJECT_DELETED]);
  });

  it('closes the 101st socket with 1013', async () => {
    const hub = newHub();
    const open = [];
    for (let i = 0; i < 100; i++) open.push(await connect(hub));
    const extra = await connect(hub);
    for (let i = 0; i < 50 && extra.closeCode() === undefined; i++) await sleep(10);
    expect(extra.closeCode()).toBe(1013);
    // The first 100 still work.
    await hub.update(snap(1));
    const last = open[99]!;
    await last.next(); // hello
    expect(json(await last.next())).toEqual({ type: 'changed', version: 1 });
  });
});
