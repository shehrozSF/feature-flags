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
  close(): void;
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

export class Stream {
  private socket: SocketLike | null = null;
  /** Failed tries since the last hello; resets only on hello, not on open. */
  private attempt = 0;
  private closed = false;
  private reconnectTimer: Timer | null = null;
  private keepaliveTimer: Timer | null = null;

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
      if (this.socket === ws) this.socket = null;
      if (this.closed) return;
      this.options.onDown();
      this.scheduleReconnect();
    };

    ws.addEventListener('open', () => this.keepAlive(ws));
    ws.addEventListener('message', (event) => {
      const data = (event as { data?: unknown }).data;
      const message = typeof data === 'string' ? parseStreamMessage(data) : null;
      if (!message) return; // pong, garbage: ignore
      if (message.type === 'hello') {
        this.attempt = 0;
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

  private keepAlive(ws: SocketLike): void {
    this.stopKeepalive();
    this.keepaliveTimer = setTimeout(() => {
      this.keepaliveTimer = null;
      if (ws.readyState !== OPEN || this.socket !== ws) return;
      ws.send('ping');
      this.keepAlive(ws);
    }, KEEPALIVE_MS);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }
}
