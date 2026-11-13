/**
 * 正向 WS：OneBot 客户端连进来。
 *
 * 借 SnowLuma `ws-server-connections.ts` 的语义：upgrade 时鉴权、按 role
 * 过滤、只给 Event/Universal 推事件、每连接独立的 messageFormat 与
 * reportSelfMessage。传输用 `ws`，不引 native addon。
 */

import type { IncomingMessage, Server } from 'node:http';
import { WebSocketServer, type WsServer, type WsSocket } from './ws-module';
import {
  CLOSE_POLICY_VIOLATION,
  DEFAULT_MAX_PAYLOAD_BYTES,
  canReceiveAction,
  canReceiveEvent,
  isAuthorized,
  MAX_BUFFERED_BYTES,
} from './index';
import type { ActionDispatcher } from '../adapter';
import type { JsonObject, MessageFormat, WsRole } from '../types';

export interface WsServerOptions {
  host?: string;
  /** 复用已有 HTTP server 时不需要（也不会被监听）。 */
  port?: number;
  path?: string;
  role?: WsRole;
  accessToken?: string;
  messageFormat: MessageFormat;
  reportSelfMessage: boolean;
  maxPayloadBytes?: number;
  /** 复用一个已有的 HTTP server（HTTP 服务端带 WS 时用）。 */
  server?: Server;
}

interface Connection {
  socket: WsSocket;
  role: WsRole;
  messageFormat: MessageFormat;
  reportSelfMessage: boolean;
}

export class WsServerAdapter {
  private server: WsServer | undefined;
  private readonly connections = new Set<Connection>();

  constructor(
    private readonly options: WsServerOptions,
    private readonly dispatch: ActionDispatcher,
  ) {}

  private get role(): WsRole {
    return this.options.role ?? 'Universal';
  }

  private get path(): string {
    return this.options.path ?? '/';
  }

  /** 启动监听；`port=0` 时由系统分配（测试用），实际端口见 {@link port}。 */
  start(): Promise<number> {
    const server = new WebSocketServer({
      ...(this.options.server ? { server: this.options.server } : {}),
      ...(this.options.server
        ? {}
        : {
            host: this.options.host ?? '127.0.0.1',
            port: this.options.port ?? 0,
          }),
      path: this.path,
      maxPayload: this.options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
      verifyClient: (info, done) => {
        const url = new URL(info.req.url ?? '/', 'http://localhost');
        if (url.pathname !== this.path) return done(false, 404, 'Not Found');
        const authorized = isAuthorized(this.options.accessToken, {
          header: info.req.headers.authorization,
          query: url.searchParams.get('access_token') ?? undefined,
        });
        done(authorized, authorized ? undefined : 401, authorized ? undefined : 'Unauthorized');
      },
    });
    this.server = server;

    server.on('connection', (socket, request) => this.onConnection(socket, request));

    return new Promise((resolve, reject) => {
      server.once('listening', () => {
        const address = server.address();
        resolve(typeof address === 'object' && address ? address.port : (this.options.port ?? 0));
      });
      server.once('error', reject);
    });
  }

  private onConnection(socket: WsSocket, _request: IncomingMessage): void {
    const connection: Connection = {
      socket,
      role: this.role,
      messageFormat: this.options.messageFormat,
      reportSelfMessage: this.options.reportSelfMessage,
    };
    this.connections.add(connection);

    socket.on('message', (raw) => {
      void this.onMessage(connection, raw.toString());
    });
    socket.on('close', () => this.connections.delete(connection));
    socket.on('error', () => this.connections.delete(connection));
  }

  private async onMessage(connection: Connection, text: string): Promise<void> {
    if (!canReceiveAction(connection.role)) {
      connection.socket.close(CLOSE_POLICY_VIOLATION, 'role does not accept actions');
      return;
    }

    let request: { action?: unknown; params?: unknown; echo?: unknown };
    try {
      request = JSON.parse(text) as typeof request;
    } catch {
      this.send(connection, {
        status: 'failed',
        retcode: 1400,
        data: null,
        wording: '请求不是合法 JSON',
      });
      return;
    }

    const action = typeof request.action === 'string' ? request.action : '';
    const params = (request.params ?? {}) as JsonObject;
    const response = await this.dispatch(action, params, { echo: request.echo });
    this.send(connection, response);
  }

  /** 推一个事件到所有 Event/Universal 连接。 */
  broadcast(event: JsonObject): void {
    for (const connection of this.connections) {
      if (!canReceiveEvent(connection.role)) continue;
      this.send(connection, event);
    }
  }

  private send(connection: Connection, payload: unknown): void {
    const socket = connection.socket;
    if (socket.readyState !== socket.OPEN) return;
    // 慢客户端保护：缓冲超限直接断开，避免无界内存增长。
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      socket.close(CLOSE_POLICY_VIOLATION, 'client too slow');
      this.connections.delete(connection);
      return;
    }
    socket.send(JSON.stringify(payload));
  }

  async stop(): Promise<void> {
    for (const connection of [...this.connections]) {
      // terminate 而不是 close：close 要等对端回 close 帧，测试/客户端不配合时会挂住。
      connection.socket.terminate();
    }
    this.connections.clear();
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // 已升级的连接不会被 `close` 打断；全部断开后端口才真正释放。
      for (const client of server.clients) client.terminate();
    });
  }
}
