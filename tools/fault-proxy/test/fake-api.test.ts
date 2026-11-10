import { EvaluateResponseSchema, parseStreamMessage, RulesetSchema } from '@ff/contracts';
import type { Ruleset } from '@ff/eval-core';
import { afterEach, describe, expect, it } from 'vitest';
import { startFakeApi, type FakeApi } from '../src/fake-api';

// The fake API stands in for the real one in SDK tests, so it must answer in
// exactly the shapes the contract defines. These tests are what keep it honest.
const ruleset = (projectVersion: number): Ruleset => ({
  projectVersion,
  flags: {
    'pk-local-payments': {
      key: 'pk-local-payments',
      enabled: true,
      variants: [
        { key: 'on', value: true },
        { key: 'off', value: false },
      ],
      offVariant: 'off',
      rules: [
        {
          id: 'pakistan',
          conditions: [{ attribute: 'country', op: 'in', values: ['PK'] }],
          serve: { variant: 'on' },
        },
      ],
      defaultServe: { variant: 'off' },
      salt: 'salt-1',
      version: 1,
    },
  },
});

let api: FakeApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

const start = async (weakEtags?: boolean) => {
  api = await startFakeApi({
    ruleset: ruleset(1),
    ...(weakEtags === undefined ? {} : { weakEtags }),
  });
  return api;
};

/** Opens a stream and collects messages; resolves next() in arrival order. */
function openStream(url: string, headers?: Record<string, string>) {
  // Node's WebSocket (undici) accepts headers as an extension to the browser API.
  const ws = new WebSocket(url, headers ? { headers } : undefined);
  const inbox: string[] = [];
  const waiting: ((m: string) => void)[] = [];
  ws.addEventListener('message', (e) => {
    const text = String(e.data);
    const w = waiting.shift();
    if (w) w(text);
    else inbox.push(text);
  });
  const next = () =>
    inbox.length > 0
      ? Promise.resolve(inbox.shift()!)
      : new Promise<string>((resolve) => waiting.push(resolve));
  const opened = new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('socket error')));
  });
  return { ws, next, opened };
}

describe('fake API', () => {
  it('rules conform to the contract and carry a weak ETag', async () => {
    const a = await start();
    const res = await fetch(`${a.url}/v1/sdk/rules`, {
      headers: { authorization: `Bearer ${a.keys.server}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('W/"1"'); // like production behind Cloudflare (#47)
    expect(RulesetSchema.safeParse(await res.json()).success).toBe(true);
  });

  it('If-None-Match with the weak or strong tag gives 304', async () => {
    const a = await start();
    for (const tag of ['W/"1"', '"1"']) {
      const res = await fetch(`${a.url}/v1/sdk/rules`, {
        headers: { authorization: `Bearer ${a.keys.server}`, 'if-none-match': tag },
      });
      expect(res.status, tag).toBe(304);
    }
  });

  it('strong ETags when asked', async () => {
    const a = await start(false);
    const res = await fetch(`${a.url}/v1/sdk/rules`, {
      headers: { authorization: `Bearer ${a.keys.server}` },
    });
    expect(res.headers.get('etag')).toBe('"1"');
  });

  it('evaluate conforms to the contract', async () => {
    const a = await start();
    const res = await fetch(`${a.url}/v1/client/evaluate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${a.keys.client}`, 'content-type': 'application/json' },
      body: JSON.stringify({ context: { userId: 'u1', country: 'PK' } }),
    });
    expect(res.status).toBe(200);
    const body = EvaluateResponseSchema.parse(await res.json());
    expect(body.version).toBe(1);
    expect(body.flags['pk-local-payments']!.value).toBe(true);
  });

  it('a socket gets hello, then changed after publish', async () => {
    const a = await start();
    const s = openStream(`${a.url.replace('http', 'ws')}/v1/client/stream?key=${a.keys.client}`);
    await s.opened;
    expect(parseStreamMessage(await s.next())).toEqual({ type: 'hello', version: 1 });
    expect(a.sockets()).toBe(1);

    a.publish(ruleset(2));
    expect(parseStreamMessage(await s.next())).toEqual({ type: 'changed', version: 2 });
    s.ws.close();
  });

  it('the server stream takes the key from the Authorization header', async () => {
    const a = await start();
    const s = openStream(`${a.url.replace('http', 'ws')}/v1/sdk/stream`, {
      authorization: `Bearer ${a.keys.server}`,
    });
    await s.opened;
    expect(parseStreamMessage(await s.next())).toEqual({ type: 'hello', version: 1 });
    const upgrade = a.requests.find((r) => r.path === '/v1/sdk/stream');
    expect(upgrade?.headers.authorization).toBe(`Bearer ${a.keys.server}`);
    s.ws.close();
  });

  it('ping gets pong', async () => {
    const a = await start();
    const s = openStream(`${a.url.replace('http', 'ws')}/v1/client/stream?key=${a.keys.client}`);
    await s.opened;
    await s.next(); // hello
    s.ws.send('ping');
    expect(await s.next()).toBe('pong');
    s.ws.close();
  });

  it('wrong key gets 401', async () => {
    const a = await start();
    const rules = await fetch(`${a.url}/v1/sdk/rules`, {
      headers: { authorization: `Bearer ${a.keys.client}` },
    });
    expect(rules.status).toBe(401);
    expect(rules.headers.get('content-type')).toContain('application/problem+json');

    const s = openStream(`${a.url.replace('http', 'ws')}/v1/client/stream?key=nope`);
    await expect(s.opened).rejects.toThrow();
  });
});
