// The SDKs' stream connection (protocol §6.3, behaviour §8.1–8.2): one WebSocket that
// reports rule versions, kept alive with `ping`, and reopened with backoff when it
// drops. It only reports; each SDK decides what to fetch. Shared by both SDKs.
import { backoffDelay, KEEPALIVE_MS, parseStreamMessage } from './stream';

// This package is shared with the API (Workers) and has no browser or Node types
// (issues #22). So the stream describes the little it uses of a WebSocket, which
// any real WebSocket satisfies, and declares the timers every target runtime has.
export type SocketLike = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  // Events are unknown here: each runtime types them differently (Workers passes a
  // plain Event to the overload this matches), and every one of them fits unknown.
  addEventListener(type: string, listener: (event: unknown) => void): void;
};
type Timer = { readonly __timer: unique symbol };
declare function setTimeout(callback: () => void, ms: number): Timer;
declare function clearTimeout(timer: Timer): void;

export type StreamOptions = {
  url: string;
  headers: Record<string, string>;
  webSocket: (url: string, headers: Record<string, string>) => SocketLike;
  random: () => number;
  backoff: { baseMs: number; capMs: number };
  /** A version from `hello` or `changed`. */
  onVersion(version: number): void;
  /** The server said hello: the stream is working. */
  onUp(): void;
  /** The socket closed or failed; a reconnect is scheduled. */
  onDown(): void;
};

const OPEN = 1;
/** No pong this long after a ping: the connection is dead, though no close came. */
export const PONG_TIMEOUT_MS = 10_000;
/** Close code for that (4000-4999 are application codes). */
export const NO_PONG = 4000;

export class Stream {
  private socket: SocketLike | null = null;
  /**
   * Failed tries in a row. Resets only once a socket has stayed open, after hello,
   * for one keepalive interval: a hub that says hello and drops keeps backing off.
   */
  private attempt = 0;
  private closed = false;
  private reconnectTimer: Timer | null = null;
  private keepaliveTimer: Timer | null = null;
  private pongTimer: Timer | null = null;
  private stableTimer: Timer | null = null;

  constructor(private readonly options: StreamOptions) {}

  connect(): void {
    if (this.closed) return;
    let ws: SocketLike;
    try {
      ws = this.options.webSocket(this.options.url, this.options.headers);
    } catch {
      this.options.onDown();
      this.scheduleReconnect();
      return;
    }
    this.socket = ws;

    let down = false;
    const goDown = () => {
      // error and close both arrive for one failure; act once.
      if (down) return;
      down = true;
      this.stopKeepalive();
      this.stopTimer('stableTimer');
      if (this.socket === ws) this.socket = null;
      if (this.closed) return;
      this.options.onDown();
      this.scheduleReconnect();
    };

    ws.addEventListener('open', () => this.keepAlive(ws, goDown));
    ws.addEventListener('message', (event) => {
      this.stopTimer('pongTimer'); // any message, pong included, proves it's alive
      const data = (event as { data?: unknown }).data;
      const message = typeof data === 'string' ? parseStreamMessage(data) : null;
      if (!message) return; // pong, garbage: ignore
      if (message.type === 'hello') {
        this.stopTimer('stableTimer');
        this.stableTimer = setTimeout(() => {
          this.stableTimer = null;
          this.attempt = 0;
        }, KEEPALIVE_MS);
        this.options.onUp();
      }
      this.options.onVersion(message.version);
    });
    ws.addEventListener('close', goDown);
    ws.addEventListener('error', goDown);
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopKeepalive();
    this.stopTimer('stableTimer');
    this.socket?.close();
    this.socket = null;
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const { baseMs, capMs } = this.options.backoff;
    const delay = backoffDelay(this.attempt, this.options.random, baseMs, capMs);
    this.attempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private keepAlive(ws: SocketLike, goDown: () => void): void {
    this.stopTimer('keepaliveTimer'); // not the pong timer: it may have just been set
    this.keepaliveTimer = setTimeout(() => {
      this.keepaliveTimer = null;
      if (ws.readyState !== OPEN || this.socket !== ws) return;
      ws.send('ping');
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null;
        // Dead without a close event: close it ourselves and reconnect now, not
        // when TCP gives up. goDown runs here, since the close may never arrive.
        try {
          ws.close(NO_PONG, 'no pong');
        } catch {
          // Already closing.
        }
        goDown();
      }, PONG_TIMEOUT_MS);
      this.keepAlive(ws, goDown);
    }, KEEPALIVE_MS);
  }

  private stopKeepalive(): void {
    this.stopTimer('keepaliveTimer');
    this.stopTimer('pongTimer');
  }

  private stopTimer(name: 'keepaliveTimer' | 'pongTimer' | 'stableTimer'): void {
    const timer = this[name];
    if (timer) clearTimeout(timer);
    this[name] = null;
  }
}
