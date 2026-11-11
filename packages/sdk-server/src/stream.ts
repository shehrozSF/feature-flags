// The streaming connection (spec §8.1, protocol §6.3): one WebSocket that reports
// rule versions, kept alive with `ping`, and reopened with backoff when it drops.
// It only reports; the client decides what to fetch.
import { backoffDelay, KEEPALIVE_MS, parseStreamMessage } from '@ff/contracts';

export type StreamOptions = {
  url: string;
  headers: Record<string, string>;
  webSocket: (url: string, headers: Record<string, string>) => WebSocket;
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
  private socket: WebSocket | null = null;
  /** Failed tries since the last hello; resets only on hello, not on open. */
  private attempt = 0;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: StreamOptions) {}

  connect(): void {
    if (this.closed) return;
    let ws: WebSocket;
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
    ws.addEventListener('message', (event: MessageEvent) => {
      const message = typeof event.data === 'string' ? parseStreamMessage(event.data) : null;
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

  private keepAlive(ws: WebSocket): void {
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
