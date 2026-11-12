import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StoredWebhook } from '../src/domain/ports';
import { buildFlagEvent } from '../src/webhooks/events';
import { createDispatcher, type Send } from '../src/webhooks/dispatcher';

// The dispatcher (ADR 0039): signs an event and POSTs it to the project's webhook,
// retrying what is worth retrying. A fake `send` stands in for the network, so each
// test decides exactly what the receiver answers.
const PROJECT = '3f2a6c1e-8b4d-4e7a-9c2f-1a2b3c4d5e6f';
const SECRET = `whsec_${'k'.repeat(43)}`;
const URL_WITH_PATH = 'https://hooks.example/webhook/abc123-secret-path';
const NOW = Date.parse('2026-11-12T10:00:00Z');

const webhook: StoredWebhook = {
  url: URL_WITH_PATH,
  secret: SECRET,
  createdAt: '2026-11-12T09:00:00.000Z',
  updatedAt: '2026-11-12T09:00:00.000Z',
};
const store = (hook: StoredWebhook | null = webhook) => ({
  getWebhook: () => Promise.resolve(hook),
});
const event = () => buildFlagEvent({ type: 'ping', projectId: PROJECT }, { now: NOW });

type Call = { url: string; headers: Record<string, string>; body: string };

/** A receiver that answers each attempt in turn: a status, or 'throw' for a network error. */
function receiver(...answers: (number | 'throw' | 'hang')[]) {
  const calls: Call[] = [];
  const send: Send = (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (answer === 'throw') return Promise.reject(new TypeError('fetch failed'));
    if (answer === 'hang') return new Promise(() => undefined);
    return Promise.resolve({ status: answer! });
  };
  return { send, calls };
}

const dispatcherWith = (send: Send, hook: StoredWebhook | null = webhook) =>
  createDispatcher({ webhooks: store(hook), send, delayMs: 0, timeoutMs: 50, now: () => NOW });

afterEach(() => vi.restoreAllMocks());

describe('delivery', () => {
  it('no webhook: nothing is sent, and the result says so (null)', async () => {
    const { send, calls } = receiver(200);
    expect(await dispatcherWith(send, null)(event())).toBeNull();
    expect(calls).toEqual([]);
  });

  it('POSTs the event as JSON, signed, to the webhook URL', async () => {
    const { send, calls } = receiver(204);
    const e = event();
    expect(await dispatcherWith(send)(e)).toEqual({ delivered: true, attempts: 1, status: 204 });

    const [call] = calls;
    expect(call!.url).toBe(URL_WITH_PATH);
    expect(JSON.parse(call!.body)).toEqual(e);
    expect(call!.headers).toMatchObject({
      'content-type': 'application/json',
      'x-ff-event-id': e.id,
      'x-ff-event-type': 'ping',
    });
  });

  it('the signature is HMAC-SHA256 of "<t>.<body>", checked with Node crypto', async () => {
    // What a receiver does (the n8n workflow too): recompute and compare.
    const { send, calls } = receiver(200);
    await dispatcherWith(send)(event());
    const { headers, body } = calls[0]!;
    const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(headers['x-ff-signature']!);
    expect(match).not.toBeNull();
    const [, t, v1] = match!;
    expect(Number(t)).toBe(NOW / 1000);
    expect(v1).toBe(createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex'));
  });
});

describe('retries', () => {
  it.each([
    ['a 500, then 200', [500, 200], { delivered: true, attempts: 2, status: 200 }],
    ['429 (slow down), then 200', [429, 200], { delivered: true, attempts: 2, status: 200 }],
    ['a network error, then 200', ['throw', 200], { delivered: true, attempts: 2, status: 200 }],
    ['always 503: gives up after 3', [503], { delivered: false, attempts: 3, status: 503 }],
    [
      'always a network error',
      ['throw'],
      { delivered: false, attempts: 3, error: 'network error' },
    ],
    ['no answer within the timeout', ['hang'], { delivered: false, attempts: 3, error: 'timeout' }],
  ] as const)('%s', async (_, answers, expected) => {
    const { send } = receiver(...answers);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await dispatcherWith(send)(event())).toEqual(expected);
  });

  it.each([
    ["400: the receiver refused it; resending the same thing won't help", 400],
    ['401: wrong secret on their side', 401],
    ['301: redirects are not followed (the URL must point at the receiver)', 301],
  ] as const)('%s', async (_, status) => {
    const { send, calls } = receiver(status);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await dispatcherWith(send)(event())).toEqual({ delivered: false, attempts: 1, status });
    expect(calls).toHaveLength(1);
  });

  it('every attempt carries the same event id, so a receiver can drop duplicates', async () => {
    const { send, calls } = receiver(500, 500, 200);
    await dispatcherWith(send)(event());
    expect(new Set(calls.map((c) => c.headers['x-ff-event-id'])).size).toBe(1);
  });

  it('attempts can be lowered per call (the test route sends once)', async () => {
    const { send, calls } = receiver(500);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await dispatcherWith(send)(event(), { attempts: 1 })).toMatchObject({ attempts: 1 });
    expect(calls).toHaveLength(1);
  });
});

describe('logs', () => {
  const linesOf = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.map(([line]) => String(line));

  it('log the host only: never the path (often secret), the signing secret or the body', async () => {
    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await dispatcherWith(receiver(200).send)(event());
    await dispatcherWith(receiver(500).send)(event());
    const lines = [...linesOf(info), ...linesOf(warn)];

    expect(lines.map((l) => JSON.parse(l) as Record<string, unknown>)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'webhook delivered', host: 'hooks.example', status: 200 }),
        expect.objectContaining({ event: 'webhook failed', host: 'hooks.example', status: 500 }),
      ]),
    );
    const all = lines.join('\n');
    for (const secret of ['abc123-secret-path', SECRET, 'whsec_', 'summary']) {
      expect(all).not.toContain(secret);
    }
  });
});
