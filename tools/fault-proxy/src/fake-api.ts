// A stand-in for the real API in SDK tests: serves rules, evaluate and both
// streams in the shapes of spec §6.1/§6.3, and lets a test change the rules at
// will (`publish`). test/fake-api.test.ts checks its answers against the contract.
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { evaluateAll, type Context, type Ruleset } from '@ff/eval-core';
import { WebSocketServer, type WebSocket } from 'ws';

export type FakeApi = {
  url: string;
  keys: { server: string; client: string };
  /** Replace the rules and tell every open socket ({type:'changed'}). */
  publish(ruleset: Ruleset): void;
  /** Every HTTP request and WebSocket upgrade, in order. */
  requests: { method: string; path: string; headers: Record<string, string | undefined> }[];
  /** Open stream connections. */
  sockets(): number;
  /** Drop every open stream connection (the client sees an abnormal close). */
  disconnect(): void;
  close(): Promise<void>;
};

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const secret = () => [...randomBytes(43)].map((b) => BASE62[b % 62]).join('');

export async function startFakeApi(options: {
  ruleset: Ruleset;
  /** Weak ETags (W/"N"), as production sends behind Cloudflare (issues #47). Default true. */
  weakEtags?: boolean;
}): Promise<FakeApi> {
  let ruleset = options.ruleset;
  const weak = options.weakEtags ?? true;
  const projectId = randomUUID();
  const keys = {
    server: `ff_server_${projectId}_${secret()}`,
    client: `ff_client_${projectId}_${secret()}`,
  };
  const requests: FakeApi['requests'] = [];
  const open = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true });

  const etag = () => (weak ? `W/"${ruleset.projectVersion}"` : `"${ruleset.projectVersion}"`);
  const bearer = (req: IncomingMessage) => req.headers.authorization?.replace(/^Bearer /, '');
  const record = (req: IncomingMessage, path: string) =>
    requests.push({
      method: req.method ?? 'GET',
      path,
      headers: Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v]),
      ),
    });

  const send = (res: ServerResponse, status: number, body: unknown, headers = {}) => {
    const problem = status >= 400;
    res.writeHead(status, {
      'content-type': problem ? 'application/problem+json' : 'application/json',
      ...headers,
    });
    res.end(
      JSON.stringify(
        problem ? { type: 'about:blank', title: 'Error', status, ...(body as object) } : body,
      ),
    );
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    record(req, url.pathname);

    if (req.method === 'GET' && url.pathname === '/v1/sdk/rules') {
      if (bearer(req) !== keys.server) return send(res, 401, { detail: 'unknown or revoked key' });
      const sent = /^(?:W\/)?"?(\d+)"?$/.exec(req.headers['if-none-match'] ?? '');
      if (sent && Number(sent[1]) === ruleset.projectVersion) {
        res.writeHead(304, { etag: etag() });
        return res.end();
      }
      return send(res, 200, ruleset, { etag: etag() });
    }

    if (req.method === 'POST' && url.pathname === '/v1/client/evaluate') {
      if (bearer(req) !== keys.client) return send(res, 401, { detail: 'unknown or revoked key' });
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        try {
          const { context } = JSON.parse(raw) as { context: Context };
          send(res, 200, { version: ruleset.projectVersion, flags: evaluateAll(ruleset, context) });
        } catch {
          send(res, 400, { detail: 'the request body is not valid JSON' });
        }
      });
      return;
    }

    send(res, 404, { detail: 'no such route' });
  });

  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    record(req, url.pathname);
    const allowed =
      (url.pathname === '/v1/sdk/stream' && bearer(req) === keys.server) ||
      (url.pathname === '/v1/client/stream' && url.searchParams.get('key') === keys.client);
    if (!allowed) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      open.add(ws);
      ws.on('close', () => open.delete(ws));
      ws.on('message', (data, isBinary) => {
        // Like the hub's setWebSocketAutoResponse; anything else is ignored.
        if (!isBinary && Buffer.isBuffer(data) && data.toString() === 'ping') ws.send('pong');
      });
      ws.send(JSON.stringify({ type: 'hello', version: ruleset.projectVersion }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    keys,
    requests,
    publish(next) {
      ruleset = next;
      const message = JSON.stringify({ type: 'changed', version: next.projectVersion });
      for (const ws of open) ws.send(message);
    },
    sockets: () => open.size,
    disconnect() {
      for (const ws of open) ws.terminate();
    },
    close: async () => {
      for (const ws of open) ws.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
