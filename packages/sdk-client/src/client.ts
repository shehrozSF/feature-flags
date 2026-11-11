// The browser SDK (spec §8.2): the API evaluates every flag for the visitor, and
// the SDK serves those results synchronously. Results are cached per visitor, so a
// reload shows the last ones at once, then fresh ones replace them.
import { BACKOFF, backoffDelay, EvaluateResponseSchema, sameJsonType } from '@ff/contracts';
import type { Context, JsonValue, Result } from '@ff/eval-core';
import {
  anonymousId,
  cacheKey,
  defaultStorage,
  readCache,
  writeCache,
  type Results,
} from './cache';

export type BrowserClientOptions = {
  /** The public client key: ff_client_<projectId>_<secret>. */
  clientKey: string;
  baseUrl: string;
  context: Context;
  /** ready() never waits longer than this. Default 2000. */
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** Default globalThis.localStorage; null means no cache. */
  storage?: Storage | null;
  /** Source of randomness for backoff jitter (tests pin it). */
  random?: () => number;
  /** Retry backoff after a failed evaluate. Default 1 s doubling to 30 s. */
  backoff?: { baseMs: number; capMs: number };
};

export type BrowserClient = {
  /** Resolves when results are available, or after timeoutMs. Never rejects. */
  ready(): Promise<void>;
  /** Synchronous and never throws; the fallback on any problem. */
  variation<T extends JsonValue>(flagKey: string, fallback: T): T;
  variationDetail(flagKey: string, fallback: JsonValue): Result;
  /** Switch to another visitor (e.g. after login) and re-evaluate. */
  identify(context: Context): Promise<void>;
  /** Called whenever the results change. Returns unsubscribe. */
  on(event: 'change', listener: () => void): () => void;
  close(): void;
};

const REQUEST_TIMEOUT_MS = 10_000;

type Resolved = Required<Omit<BrowserClientOptions, 'storage'>> & { storage: Storage | null };

/** Retry-After in seconds (spec §9.1). */
function retryAfterMs(res: Response): number {
  const seconds = Number(res.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

class Client implements BrowserClient {
  private context: Context;
  private results: Results | null;
  /** Bumped by identify(): responses for an older context are dropped. */
  private contextGeneration = 0;
  private failures = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly readyPromise: Promise<void>;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly requests = new Set<AbortController>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly options: Resolved) {
    this.context = this.withUserId(options.context);
    // Stale-while-revalidate: serve the cache now, replace it when the API answers.
    this.results = readCache(options.storage, this.key());
    const first = this.evaluate();
    this.readyPromise = this.results
      ? Promise.resolve()
      : this.waitAtMost(first, options.timeoutMs);
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  variationDetail(flagKey: string, fallback: JsonValue): Result {
    const error: Result = { variant: null, value: fallback, reason: 'ERROR' };
    try {
      if (!this.results) return error;
      if (!Object.hasOwn(this.results.flags, flagKey)) {
        return { variant: null, value: fallback, reason: 'FLAG_NOT_FOUND' };
      }
      const result = this.results.flags[flagKey]!;
      if (result.reason === 'ERROR') return error;
      // Asking for a boolean and getting "blue" is a bug, not a value to use.
      return sameJsonType(result.value, fallback) ? result : error;
    } catch {
      return error;
    }
  }

  variation<T extends JsonValue>(flagKey: string, fallback: T): T {
    return this.variationDetail(flagKey, fallback).value as T;
  }

  async identify(context: Context): Promise<void> {
    if (this.closed) return;
    this.contextGeneration++;
    this.cancelRetry();
    this.failures = 0;
    this.context = this.withUserId(context);
    this.replace(readCache(this.options.storage, this.key()));
    await this.evaluate();
  }

  on(_event: 'change', listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.retryTimer = null;
    for (const request of this.requests) request.abort();
    this.requests.clear();
    this.listeners.clear();
  }

  /** POST /v1/client/evaluate for the current context. Never rejects. */
  private async evaluate(): Promise<void> {
    if (this.closed) return;
    const generation = this.contextGeneration;
    const stale = () => this.closed || generation !== this.contextGeneration;
    const request = new AbortController();
    this.requests.add(request);
    const timeout = this.after(REQUEST_TIMEOUT_MS, () => request.abort());
    try {
      const res = await this.options.fetch(`${this.options.baseUrl}/v1/client/evaluate`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.clientKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ context: this.context }),
        signal: request.signal,
      });
      if (stale()) return;
      if (res.status !== 200) return this.failed(retryAfterMs(res));
      const parsed = EvaluateResponseSchema.safeParse(await res.json());
      if (stale()) return;
      if (!parsed.success) return this.failed(0); // keep the previous results

      this.failures = 0;
      // An older answer never replaces a newer one for the same visitor.
      if (this.results && parsed.data.version < this.results.version) return;
      this.replace(parsed.data);
      writeCache(this.options.storage, this.key(), parsed.data);
    } catch {
      if (!stale()) this.failed(0);
    } finally {
      this.cancel(timeout);
      this.requests.delete(request);
    }
  }

  /** Keep what we have and try again after a backoff (or Retry-After, if longer). */
  private failed(retryAfter: number): void {
    const { baseMs, capMs } = this.options.backoff;
    const wait = Math.max(
      backoffDelay(this.failures, this.options.random, baseMs, capMs),
      retryAfter,
    );
    this.failures++;
    this.cancelRetry();
    this.retryTimer = this.after(wait, () => {
      this.retryTimer = null;
      void this.evaluate();
    });
  }

  private replace(next: Results | null): void {
    const changed = JSON.stringify(next) !== JSON.stringify(this.results);
    this.results = next;
    if (changed) this.emit();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // A failing listener must not break the SDK or other listeners.
      }
    }
  }

  private withUserId(context: Context): Context {
    return context.userId === undefined
      ? { ...context, userId: anonymousId(this.options.storage) }
      : { ...context };
  }

  private key(): string {
    return cacheKey(this.options.clientKey, this.context);
  }

  private async waitAtMost(promise: Promise<void>, ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      promise,
      new Promise<void>((resolve) => (timer = this.after(ms, resolve))),
    ]);
    if (timer) this.cancel(timer);
  }

  private cancelRetry(): void {
    if (this.retryTimer) this.cancel(this.retryTimer);
    this.retryTimer = null;
  }

  private after(ms: number, fn: () => void): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
    return timer;
  }

  private cancel(timer: ReturnType<typeof setTimeout>): void {
    clearTimeout(timer);
    this.timers.delete(timer);
  }
}

export function createBrowserClient(options: BrowserClientOptions): BrowserClient {
  return new Client({
    timeoutMs: 2000,
    random: Math.random,
    backoff: BACKOFF,
    ...options,
    baseUrl: options.baseUrl.replace(/\/+$/, ''),
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
    storage: options.storage === undefined ? defaultStorage() : options.storage,
  });
}
