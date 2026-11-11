import { DurableObject } from 'cloudflare:workers';
import type { ProjectSnapshot } from '../../domain/ports';
import {
  DELETED,
  MAX_SOCKETS_PER_PROJECT,
  PROJECT_DELETED,
  readState,
  updateState,
  type HubClient,
  type HubRead,
  type HubState,
  type StoredHub,
} from '../../hub/hub-client';
import type { KeyKind } from '../../keys';
import type { Env } from './env';

// 1013 = "try again later" (RFC 6455 registry).
const TRY_AGAIN_LATER = 1013;

/**
 * One hub per project (addressed by project id). It never talks to Postgres: the
 * Worker pushes snapshots in (ADR 0029). It keeps the latest snapshot in durable
 * storage and tells connected SDKs when the version changes (spec §6.3).
 */
export class ProjectHub extends DurableObject<Env> implements HubClient {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Answered by the runtime without waking the object, so idle SDKs cost nothing.
    // The constructor reruns on every wake-up, so nothing heavy belongs here.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async read(kind: KeyKind, hashHex: string): Promise<HubRead> {
    // A Durable Object handles one event at a time, so claiming the refresh here
    // is atomic: concurrent readers can't both be asked to refresh.
    const { read, next } = readState(await this.stored(), kind, hashHex, Date.now());
    if (next) await this.ctx.storage.put<HubState>('snapshot', next);
    return read;
  }

  async update(snapshot: ProjectSnapshot): Promise<{ applied: boolean; version: number }> {
    const { next, applied, version } = updateState(await this.stored(), snapshot, Date.now());
    if (next) await this.ctx.storage.put<HubState>('snapshot', next);
    if (applied) this.broadcast({ type: 'changed', version });
    return { applied, version };
  }

  async clear(): Promise<void> {
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.put<StoredHub>('snapshot', DELETED);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(PROJECT_DELETED, 'project deleted');
      } catch {
        // Already closing.
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected a WebSocket upgrade', { status: 426 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    const stored = await this.stored();

    if (stored && 'deleted' in stored) {
      // Same close code a connected socket gets when its project is deleted.
      server.accept();
      server.close(PROJECT_DELETED, 'project deleted');
      return new Response(null, { status: 101, webSocket: client });
    }

    if (this.ctx.getWebSockets().length >= MAX_SOCKETS_PER_PROJECT) {
      // Not hibernatable and not counted: accept only to send the close code.
      server.accept();
      server.close(TRY_AGAIN_LATER, 'too many connections for this project');
      return new Response(null, { status: 101, webSocket: client });
    }

    // Hibernatable: the object can leave memory while sockets stay open.
    this.ctx.acceptWebSocket(server);
    const version = stored?.snapshot.ruleset.projectVersion ?? 0;
    server.send(JSON.stringify({ type: 'hello', version }));
    return new Response(null, { status: 101, webSocket: client });
  }

  // Clients only send `ping` (auto-answered above). Anything else is ignored:
  // no reply and no close, so a buggy or hostile client can't disturb the hub.
  webSocketMessage(): void {}

  // Answer the client's close frame to finish the handshake. Without this the
  // client waits ~10 s and ends with 1006 "abnormal closure" (issues log #44).
  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    try {
      // 1005/1006 mean "no code"/"abnormal" and can't be sent back on the wire.
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // Already closed.
    }
  }

  private stored(): Promise<StoredHub | undefined> {
    return this.ctx.storage.get<StoredHub>('snapshot');
  }

  private broadcast(message: { type: 'changed'; version: number }): void {
    const text = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
      } catch {
        // Already closing; the runtime cleans it up.
      }
    }
  }
}
