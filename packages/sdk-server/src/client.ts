// The server SDK (spec §8.1): rules are fetched from the API and every flag is
// evaluated locally, so `variation` is synchronous and keeps working when the API
// is down. The last good ruleset is kept through any failure.
import { BACKOFF, backoffDelay, sameJsonType, Stream } from '@ff/contracts';
import { evaluate, type Context, type JsonValue, type Result, type Ruleset } from '@ff/eval-core';
import { fetchRules, type Logger } from './rules-fetcher';

export type ServerClientOptions = {
  serverKey: string;
  baseUrl: string;
  /** streaming: long-lived servers; polling: Workers and serverless. */
  mode: 'streaming' | 'polling';
  /** Init never waits longer than this. Default 2000. */
  timeoutMs?: number;
  /** Streaming mode: how often to poll while the socket is down. Default 30000. */
  pollIntervalMs?: number;
  /** Polling mode: how long rules are reused before a background revalidation. Default 5000. */
  cacheTtlMs?: number;
  fetch?: typeof fetch;
  /** Source of randomness for backoff jitter (tests pin it). */
  random?: () => number;
  logger?: Logger;
  /**
   * Opens the stream socket. Default: the global WebSocket with the key in an
   * Authorization header (Node's WebSocket supports headers; browsers' does not).
   */
  webSocket?: (url: string, headers: Record<string, string>) => WebSocket;
  /** Reconnect backoff. Default 1 s doubling to 30 s, with full jitter. */
  backoff?: { baseMs: number; capMs: number };
};

export type ServerClient = {
  /** Synchronous and never throws; the fallback on any problem. */
  variation<T extends JsonValue>(flagKey: string, context: Context, fallback: T): T;
  /** Like variation, with the variant and the reason (ERROR, FLAG_NOT_FOUND, …). */
  variationDetail(flagKey: string, context: Context, fallback: JsonValue): Result;
  /** Called with the new projectVersion whenever newer rules arrive. Returns unsubscribe. */
  on(event: 'change', listener: (version: number) => void): () => void;
  /** Revalidate now. Never rejects; a Worker can hand it to ctx.waitUntil. */
  refresh(): Promise<void>;
  /** The projectVersion held, or null before the first rules arrive. */
  version(): number | null;
  /** Stops all timers, requests and sockets. */
  close(): void;
};

/** A single rules request is abandoned after this long. */
const REQUEST_TIMEOUT_MS = 10_000;

type Resolved = Required<Omit<ServerClientOptions, 'fetch'>> & { fetch: typeof fetch };

class Client implements ServerClient {
  private ruleset: Ruleset | null = null;
  private etag: string | null = null;
  /** When the API last confirmed our rules (200 or 304). */
  private checkedAt = 0;
  /** After a failure: no new attempt before this time. */
  private retryAt = 0;
  private failures = 0;
  private inflight: Promise<void> | null = null;
  private closed = false;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly requests = new Set<AbortController>();
  private readonly listeners = new Set<(version: number) => void>();
  private stream: Stream | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: Resolved) {}

  version(): number | null {
    return this.ruleset?.projectVersion ?? null;
  }

  variationDetail(flagKey: string, context: Context, fallback: JsonValue): Result {
    const error: Result = { variant: null, value: fallback, reason: 'ERROR' };
    try {
      this.revalidateIfDue();
      if (!this.ruleset) return error;
      const result = evaluate(this.ruleset, flagKey, context, fallback);
      if (result.reason === 'ERROR' || result.reason === 'FLAG_NOT_FOUND') return result;
      // Asking for a boolean and getting "blue" is a bug, not a value to use.
      return sameJsonType(result.value, fallback) ? result : error;
    } catch {
      return error;
    }
  }

  variation<T extends JsonValue>(flagKey: string, context: Context, fallback: T): T {
    return this.variationDetail(flagKey, context, fallback).value as T;
  }

  on(_event: 'change', listener: (version: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.inflight ??= this.load().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  close(): void {
    this.closed = true;
    this.stream?.close();
    this.stream = null;
    this.pollTimer = null;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const request of this.requests) request.abort();
    this.requests.clear();
    this.listeners.clear();
  }

  /** Resolves when `promise` settles or after `ms`, whichever is first. */
  async waitAtMost(promise: Promise<void>, ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      promise,
      new Promise<void>((resolve) => (timer = this.after(ms, resolve))),
    ]);
    if (timer) this.cancel(timer);
  }

  /** Streaming mode: a socket reports new versions; poll while it is down. */
  startStream(): void {
    if (this.closed || this.options.mode !== 'streaming') return;
    this.stream = new Stream({
      url: `${this.options.baseUrl.replace(/^http/, 'ws')}/v1/sdk/stream`,
      headers: { authorization: `Bearer ${this.options.serverKey}` },
      webSocket: this.options.webSocket,
      random: this.options.random,
      backoff: this.options.backoff,
      onVersion: (version) => {
        const held = this.version();
        if (held === null || version > held) void this.refresh();
      },
      onUp: () => this.stopPolling(),
      onDown: () => this.startPolling(),
    });
    this.stream.connect();
  }

  private startPolling(): void {
    if (this.closed || this.pollTimer) return;
    this.pollTimer = this.after(this.options.pollIntervalMs, () => {
      this.pollTimer = null;
      void this.refresh();
      this.startPolling();
    });
  }

  private stopPolling(): void {
    if (this.pollTimer) this.cancel(this.pollTimer);
    this.pollTimer = null;
  }

  /** Until the first rules arrive, keep trying in the background. */
  retryUntilLoaded(): void {
    if (this.closed || this.ruleset) return;
    this.after(Math.max(0, this.retryAt - Date.now()), () => {
      void this.refresh().then(() => this.retryUntilLoaded());
    });
  }

  private revalidateIfDue(): void {
    const now = Date.now();
    if (
      this.options.mode === 'polling' &&
      this.ruleset &&
      !this.inflight &&
      now - this.checkedAt >= this.options.cacheTtlMs &&
      now >= this.retryAt
    ) {
      void this.refresh();
    }
  }

  private async load(): Promise<void> {
    const request = new AbortController();
    this.requests.add(request);
    const timeout = this.after(REQUEST_TIMEOUT_MS, () => request.abort());
    try {
      const result = await fetchRules({
        fetch: this.options.fetch,
        baseUrl: this.options.baseUrl,
        serverKey: this.options.serverKey,
        etag: this.etag,
        signal: request.signal,
        logger: this.options.logger,
      });
      if (this.closed) return;

      if (result.kind === 'failed') {
        const { baseMs, capMs } = this.options.backoff;
        const wait = backoffDelay(this.failures, this.options.random, baseMs, capMs);
        this.failures++;
        this.retryAt = Date.now() + Math.max(wait, result.retryAfterMs ?? 0);
        return;
      }
      this.failures = 0;
      this.retryAt = 0;
      this.checkedAt = Date.now();
      if (result.kind === 'unchanged') {
        this.etag = result.etag;
      } else if (this.apply(result.ruleset)) {
        this.etag = result.etag;
      }
    } finally {
      this.cancel(timeout);
      this.requests.delete(request);
    }
  }

  /** False if the ruleset is older than the one held (out-of-order answers). */
  private apply(ruleset: Ruleset): boolean {
    const held = this.ruleset?.projectVersion;
    if (held !== undefined && ruleset.projectVersion < held) return false;
    this.ruleset = ruleset;
    if (held === undefined || ruleset.projectVersion > held) this.emit(ruleset.projectVersion);
    return true;
  }

  private emit(version: number): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(version);
      } catch {
        // A failing listener must not break the SDK or other listeners.
      }
    }
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

/** Never rejects: if the API is slow or down, it resolves after timeoutMs with fallbacks. */
export async function createServerClient(options: ServerClientOptions): Promise<ServerClient> {
  const client = new Client({
    timeoutMs: 2000,
    pollIntervalMs: 30_000,
    cacheTtlMs: 5000,
    random: Math.random,
    logger: { warn: (message) => console.warn(message) },
    // DOM typings only allow protocols as the 2nd argument; Node's WebSocket also takes headers.
    webSocket: (url, headers) => new WebSocket(url, { headers } as unknown as string[]),
    backoff: BACKOFF,
    ...options,
    baseUrl: options.baseUrl.replace(/\/+$/, ''),
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
  });
  await client.waitAtMost(client.refresh(), options.timeoutMs ?? 2000);
  client.retryUntilLoaded();
  client.startStream();
  return client;
}
