import { DurableObject } from 'cloudflare:workers';
import type { ProjectSnapshot } from '../../domain/ports';
import {
  MAX_SOCKETS_PER_PROJECT,
  PROJECT_DELETED,
  readState,
  updateState,
  type HubClient,
  type HubRead,
  type HubState,
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
    return readState(await this.stored(), kind, hashHex);
  }

  async update(snapshot: ProjectSnapshot): Promise<{ applied: boolean; version: number }> {
    const { next, applied, version } = updateState(await this.stored(), snapshot, Date.now());
    if (next) await this.ctx.storage.put<HubState>('snapshot', next);
    if (applied) this.broadcast({ type: 'changed', version });
    return { applied, version };
  }

  async clear(): Promise<void> {
    await this.ctx.storage.deleteAll();
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

    if (this.ctx.getWebSockets().length >= MAX_SOCKETS_PER_PROJECT) {
      // Not hibernatable and not counted: accept only to send the close code.
      server.accept();
      server.close(TRY_AGAIN_LATER, 'too many connections for this project');
      return new Response(null, { status: 101, webSocket: client });
    }

    // Hibernatable: the object can leave memory while sockets stay open.
    this.ctx.acceptWebSocket(server);
    const version = (await this.stored())?.snapshot.ruleset.projectVersion ?? 0;
    server.send(JSON.stringify({ type: 'hello', version }));
    return new Response(null, { status: 101, webSocket: client });
  }

  // Clients only send `ping` (auto-answered above). Anything else is ignored:
  // no reply and no close, so a buggy or hostile client can't disturb the hub.
  webSocketMessage(): void {}

  webSocketClose(): void {}

  private stored(): Promise<HubState | undefined> {
    return this.ctx.storage.get<HubState>('snapshot');
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
