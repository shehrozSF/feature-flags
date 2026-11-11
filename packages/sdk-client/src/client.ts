// The browser SDK (spec §8.2): the API evaluates every flag for the visitor, and
// the SDK serves those results synchronously. Results are cached per visitor, so a
// reload shows the last ones at once, then fresh ones replace them.
import {
  BACKOFF,
  backoffDelay,
  EvaluateResponseSchema,
  sameJsonType,
  type SocketLike,
} from '@ff/contracts';
import type { Context, JsonValue, Result } from '@ff/eval-core';
import {
  anonymousId,
  cacheKey,
  defaultStorage,
  readCache,
  writeCache,
  type Results,
} from './cache';
import { Live, type VisibilitySource } from './live';

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
  /** Retry and reconnect backoff. Default 1 s doubling to 30 s. */
  backoff?: { baseMs: number; capMs: number };
  /** Opens the stream socket. Default: the global WebSocket. */
  webSocket?: (url: string) => SocketLike;
  /** Tab visibility (hidden tabs close the socket). Default: globalThis.document. */
  document?: VisibilitySource | null;
  /** Where to report problems the app developer must fix. Default console.warn. */
  logger?: { warn(message: string): void };
  /** How often to poll while the socket is down. Default 30000. */
  pollIntervalMs?: number;
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

/**
 * Answers that retrying can't fix: a bad or revoked key (401, 403) or a context the
 * API rejects (400, 413, 422). Reported once, then no retries for that visitor
 * until identify() (final review I4).
 */
const NOT_RETRYABLE = new Set([400, 401, 403, 413, 422]);

type Resolved = Required<Omit<BrowserClientOptions, 'storage' | 'document'>> & {
  storage: Storage | null;
  document: VisibilitySource | null;
};

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
  private readonly live: Live;
  /** One evaluate at a time per visitor; repeated triggers share it (final review I3). */
  private inflight: { generation: number; promise: Promise<void> } | null = null;
  /** The visitor (generation) whose requests the API rejected for good. */
  private rejectedGeneration = -1;

  constructor(private readonly options: Resolved) {
    this.context = this.withUserId(options.context);
    // Stale-while-revalidate: serve the cache now, replace it when the API answers.
    this.results = readCache(options.storage, this.key());
    const first = this.evaluate();
    this.readyPromise = this.results
      ? Promise.resolve()
      : this.waitAtMost(first, options.timeoutMs);

    this.live = new Live({
      url: `${options.baseUrl.replace(/^http/, 'ws')}/v1/client/stream?key=${encodeURIComponent(options.clientKey)}`,
      webSocket: options.webSocket,
      document: options.document,
      random: options.random,
      backoff: options.backoff,
      pollIntervalMs: options.pollIntervalMs,
      heldVersion: () => this.results?.version ?? null,
      evaluate: () => void this.evaluate(),
    });
    this.live.start();
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
    this.live.close();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.retryTimer = null;
    for (const request of this.requests) request.abort();
    this.requests.clear();
    this.listeners.clear();
  }

  /** Evaluate for the current visitor, sharing a request already in flight. Never rejects. */
  private evaluate(): Promise<void> {
    if (this.closed) return Promise.resolve();
    const generation = this.contextGeneration;
    if (generation === this.rejectedGeneration) return Promise.resolve();
    if (this.inflight?.generation === generation) return this.inflight.promise;
    const promise = this.request(generation).finally(() => {
      if (this.inflight?.promise === promise) this.inflight = null;
    });
    this.inflight = { generation, promise };
    return promise;
  }

  /** POST /v1/client/evaluate for the current context. Never rejects. */
  private async request(generation: number): Promise<void> {
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
      if (NOT_RETRYABLE.has(res.status)) {
        this.rejectedGeneration = generation;
        // Route and status only: the context may hold personal data (spec §9.3).
        this.options.logger.warn(
          `feature flags: POST /v1/client/evaluate answered ${res.status}; not retrying until identify()`,
        );
        return;
      }
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
    pollIntervalMs: 30_000,
    logger: { warn: (message) => console.warn(message) },
    webSocket: (url) => new WebSocket(url),
    ...options,
    baseUrl: options.baseUrl.replace(/\/+$/, ''),
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
    storage: options.storage === undefined ? defaultStorage() : options.storage,
    document: options.document === undefined ? (globalThis.document ?? null) : options.document,
  });
}
