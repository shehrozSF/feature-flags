// A proxy that breaks the network on purpose (spec §10, resilience tests). It works
// at the socket level, so SDKs see real failures: refused connections, dropped
// sockets, slow answers, broken bodies. WebSocket upgrades are piped raw.
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';

export type Fault =
  | { kind: 'pass' }
  /** Every open connection is destroyed, and new ones are destroyed on arrival. */
  | { kind: 'down' }
  /** Each request or upgrade waits `ms` before it is forwarded. */
  | { kind: 'delay'; ms: number }
  /** A 200 JSON body is replaced with valid JSON of the wrong shape; sockets pass. */
  | { kind: 'corrupt' };

export type FaultProxy = {
  url: string;
  set(fault: Fault): void;
  /** Open client connections (HTTP and WebSocket). */
  connections(): number;
  close(): Promise<void>;
};

/** Valid JSON, invalid as a ruleset or an evaluate response. */
export const CORRUPT_BODY = JSON.stringify({ projectVersion: 999999, flags: 'corrupted' });

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startFaultProxy(options: { target: string }): Promise<FaultProxy> {
  const target = new URL(options.target);
  let fault: Fault = { kind: 'pass' };
  // Read through a function: a test may switch the fault while a request waits.
  const current = (): Fault => fault;

  // Client connections and the proxy's own connections to the target, kept apart
  // so connections() counts clients; 'down' destroys both.
  const clients = new Set<Socket>();
  const upstreams = new Set<Socket>();
  const track = (set: Set<Socket>) => (socket: Socket) => {
    set.add(socket);
    socket.on('close', () => set.delete(socket));
  };
  const destroyAll = () => {
    for (const socket of [...clients, ...upstreams]) socket.destroy();
  };

  /** Applies down/delay; false means the connection was dropped. */
  const admit = async (socket: Socket): Promise<boolean> => {
    const f = current();
    if (f.kind === 'delay') await wait(f.ms);
    if (current().kind === 'down') {
      socket.destroy();
      return false;
    }
    return true;
  };

  const forward = async (req: IncomingMessage, res: ServerResponse) => {
    if (!(await admit(req.socket))) return;
    const upstream = request(
      {
        host: target.hostname,
        port: target.port,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: target.host },
      },
      (answer) => {
        const json = answer.headers['content-type']?.includes('application/json');
        if (current().kind === 'corrupt' && answer.statusCode === 200 && json) {
          answer.resume(); // drop the real body
          const headers = {
            ...answer.headers,
            'content-length': String(Buffer.byteLength(CORRUPT_BODY)),
          };
          delete headers['transfer-encoding'];
          res.writeHead(200, headers);
          res.end(CORRUPT_BODY);
          return;
        }
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on('error', () => req.socket.destroy());
    req.pipe(upstream);
  };

  const tunnel = async (req: IncomingMessage, client: Socket, head: Buffer) => {
    if (!(await admit(client))) return;
    const upstream = connect(Number(target.port), target.hostname, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i]!;
        lines.push(
          `${name}: ${name.toLowerCase() === 'host' ? target.host : req.rawHeaders[i + 1]}`,
        );
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    track(upstreams)(upstream);
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
    client.on('close', () => upstream.destroy());
  };

  const server = createServer((req, res) => void forward(req, res));
  server.on('connection', track(clients));
  server.on('upgrade', (req: IncomingMessage, client: Socket, head: Buffer) => {
    void tunnel(req, client, head);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    set(next) {
      fault = next;
      if (next.kind === 'down') destroyAll();
    },
    connections: () => clients.size,
    close: async () => {
      destroyAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
