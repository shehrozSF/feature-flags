// Sends flag-change events to a project's webhook (ADR 0039). Runs after the write
// has committed, in the background: nothing here can slow or fail the write. Best
// effort: if every attempt fails, the event is logged as failed and dropped.
import type { FlagEvent } from '@ff/contracts';
import type { StoredWebhook } from '../domain/ports';
import { TimeoutError, withTimeout } from '../hub/timeout';
import { toHex } from '../keys';
import { log } from '../log';
import { parseUrl, postNoFollow, textEncoder, webCrypto } from '../web';

/** One HTTP POST; resolves with the status, rejects on a network error. */
export type Send = (
  url: string,
  init: { headers: Record<string, string>; body: string },
  timeoutMs: number,
) => Promise<{ status: number }>;

export type DeliveryResult = {
  delivered: boolean;
  attempts: number;
  /** The last answer's status, if there was one. */
  status?: number;
  /** Why the last attempt got no answer: never the raw error (it may hold the URL). */
  error?: 'timeout' | 'network error';
};

/** Null when the project has no webhook. */
export type Dispatch = (
  event: FlagEvent,
  options?: { attempts?: number },
) => Promise<DeliveryResult | null>;

/**
 * Worth trying again: no answer, the receiver failing (5xx), or asking us to slow
 * down (429) or retry (408). Any other 4xx means it refused this event, and a 3xx
 * means the URL points somewhere else; sending the same request again won't help.
 */
const retryable = (status: number) => status >= 500 || status === 429 || status === 408;

/** "t=<unix seconds>,v1=<hex HMAC-SHA256 of '<t>.<body>'>", as Stripe does it. */
export async function signatureHeader(
  secret: string,
  body: string,
  nowMs: number,
): Promise<string> {
  const t = Math.floor(nowMs / 1000);
  const key = await webCrypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await webCrypto.subtle.sign('HMAC', key, textEncoder.encode(`${t}.${body}`));
  return `t=${t},v1=${toHex(new Uint8Array(mac))}`;
}

export function createDispatcher(deps: {
  webhooks: { getWebhook(projectId: string): Promise<StoredWebhook | null> };
  send?: Send;
  attempts?: number;
  /** Wait before the 2nd attempt; doubles after each. */
  delayMs?: number;
  /** One attempt slower than this counts as no answer. */
  timeoutMs?: number;
  now?: () => number;
}): Dispatch {
  const send = deps.send ?? postNoFollow;
  const defaultAttempts = deps.attempts ?? 3;
  const firstDelay = deps.delayMs ?? 500;
  const timeoutMs = deps.timeoutMs ?? 5_000;
  const now = deps.now ?? Date.now;

  return async (event, options = {}) => {
    const webhook = await deps.webhooks.getWebhook(event.projectId);
    if (!webhook) return null;

    const body = JSON.stringify(event);
    const fields = {
      projectId: event.projectId,
      eventType: event.type,
      host: parseUrl(webhook.url).host,
    };
    const attempts = options.attempts ?? defaultAttempts;
    let result: DeliveryResult = { delivered: false, attempts: 0 };

    for (let n = 1; n <= attempts; n++) {
      // Signed per attempt: the timestamp is when it was sent, so a retry minutes
      // later isn't refused by a receiver that rejects old signatures.
      const headers = {
        'content-type': 'application/json',
        'x-ff-event-id': event.id,
        'x-ff-event-type': event.type,
        'x-ff-signature': await signatureHeader(webhook.secret, body, now()),
      };
      try {
        const { status } = await withTimeout(
          send(webhook.url, { headers, body }, timeoutMs),
          timeoutMs,
          'webhook delivery',
        );
        result = { delivered: status >= 200 && status < 300, attempts: n, status };
        if (result.delivered) {
          log('info', 'webhook delivered', { ...fields, status, attempt: n });
          return result;
        }
        log('warn', 'webhook failed', { ...fields, status, attempt: n });
        if (!retryable(status)) return result;
      } catch (error) {
        result = {
          delivered: false,
          attempts: n,
          error: error instanceof TimeoutError || isAbort(error) ? 'timeout' : 'network error',
        };
        log('warn', 'webhook failed', { ...fields, attempt: n, error });
      }
      if (n < attempts) await sleep(firstDelay * 2 ** (n - 1));
    }
    return result;
  };
}

/** fetch's own timeout (AbortSignal.timeout) rejects with a TimeoutError DOMException. */
const isAbort = (error: unknown) =>
  error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
