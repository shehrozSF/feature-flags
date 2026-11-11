// An in-memory WebSocket for tests that need exact control over timing: the test
// decides when it opens, what it receives and when it drops. Real-network
// behaviour is tested against the fake API instead.
export class FakeSocket extends EventTarget {
  readyState = 0; // CONNECTING
  readonly sent: string[] = [];
  closedByClient = false;
  /** The code the SDK closed it with, if any. */
  closeCode: number | undefined;

  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {
    super();
  }

  send(data: string): void {
    this.sent.push(data);
  }

  /** The SDK closing it. */
  close(code?: number): void {
    this.closedByClient = true;
    this.closeCode = code;
    this.drop();
  }

  open(): void {
    this.readyState = 1; // OPEN
    this.dispatchEvent(new Event('open'));
  }

  message(data: string): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }

  /** The connection ending (server close, network loss). */
  drop(): void {
    if (this.readyState === 3) return;
    this.readyState = 3; // CLOSED
    this.dispatchEvent(new Event('close'));
  }
}

/** A webSocket option for the SDK that records every socket it opens. */
export function fakeSockets(onCreate: (socket: FakeSocket) => void = () => undefined) {
  const sockets: FakeSocket[] = [];
  const webSocket = (url: string, headers: Record<string, string>) => {
    const socket = new FakeSocket(url, headers);
    sockets.push(socket);
    onCreate(socket);
    return socket as unknown as WebSocket;
  };
  return { sockets, webSocket };
}
