// Live updates for the browser SDK (spec §8.2): the stream says when rules changed,
// and the client re-evaluates after a short debounce. While the socket is down it
// polls; in a hidden tab it does neither, to save Durable Object quota.
import { Stream, type SocketLike } from '@ff/contracts';

/** The part of `document` this needs (tests pass a fake). */
export type VisibilitySource = {
  readonly hidden: boolean;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
};

export type LiveOptions = {
  url: string;
  webSocket: (url: string) => SocketLike;
  document: VisibilitySource | null;
  random: () => number;
  backoff: { baseMs: number; capMs: number };
  pollIntervalMs: number;
  /** The results version the client holds, or null if it has none. */
  heldVersion(): number | null;
  /** Re-evaluate for the current visitor. */
  evaluate(): void;
};

/** Several `changed` messages within this window lead to one evaluate. */
export const DEBOUNCE_MS = 250;

export class Live {
  private stream: Stream | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  /** The newest version announced while a re-evaluate was pending. */
  private wanted = -1;
  private readonly onVisibility = () => this.visibilityChanged();

  constructor(private readonly options: LiveOptions) {}

  start(): void {
    this.options.document?.addEventListener('visibilitychange', this.onVisibility);
    if (!this.options.document?.hidden) this.connect();
  }

  close(): void {
    this.closed = true;
    this.disconnect();
    this.options.document?.removeEventListener('visibilitychange', this.onVisibility);
  }

  private connect(): void {
    if (this.closed || this.stream) return;
    this.stream = new Stream({
      url: this.options.url,
      headers: {}, // browsers can't set WebSocket headers; the client key is in the URL
      webSocket: (url) => this.options.webSocket(url),
      random: this.options.random,
      backoff: this.options.backoff,
      onVersion: (version) => {
        const held = this.options.heldVersion();
        if (held === null || version > held) this.debounce(version);
      },
      onUp: () => this.stopPolling(),
      onDown: () => this.startPolling(),
    });
    this.stream.connect();
  }

  private disconnect(): void {
    this.stream?.close();
    this.stream = null;
    this.stopPolling();
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
  }

  private visibilityChanged(): void {
    if (this.closed) return;
    if (this.options.document?.hidden) {
      this.disconnect();
    } else {
      this.options.evaluate(); // catch up on whatever changed while hidden
      this.connect();
    }
  }

  private debounce(version: number): void {
    this.wanted = Math.max(this.wanted, version);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      // Re-check when it fires: an evaluate that was already running may have
      // brought us up to date in the meantime (final review I3).
      const held = this.options.heldVersion();
      if (held === null || held < this.wanted) this.options.evaluate();
    }, DEBOUNCE_MS);
  }

  private startPolling(): void {
    if (this.closed || this.pollTimer) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      this.options.evaluate();
      this.startPolling();
    }, this.options.pollIntervalMs);
  }

  private stopPolling(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }
}
