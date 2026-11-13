/**
 * HTTP 服务端：OneBot v11 的 `POST /<action>` 接口。
 *
 * 借 SnowLuma `http-server-adapter.ts` 的路由与鉴权形状，简化到 WeqBot 需要
 * 的程度：每个 action 一个 `POST`，返回 JSON；`GET /` 做健康检查。
 * 可选在同一个监听上挂 WS（`enableWebSocket`），省一个端口。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isAuthorized } from './index';
import type { ActionDispatcher } from '../adapter';
import type { JsonObject, MessageFormat } from '../types';
import { WsServerAdapter } from './ws-server';

export interface HttpServerOptions {
  host?: string;
  port: number;
  path?: string;
  accessToken?: string;
  messageFormat: MessageFormat;
  reportSelfMessage: boolean;
  enableWebSocket?: boolean;
}

export class HttpServerAdapter {
  private server: Server | undefined;
  private ws: WsServerAdapter | undefined;

  constructor(
    private readonly options: HttpServerOptions,
    private readonly dispatch: ActionDispatcher,
  ) {}

  private get path(): string {
    return (this.options.path ?? '/').replace(/\/$/, '') || '';
  }

  async start(): Promise<number> {
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server = server;

    await new Promise<void>((resolve) => {
      server.listen(this.options.port, this.options.host ?? '127.0.0.1', () => resolve());
    });

    if (this.options.enableWebSocket) {
      this.ws = new WsServerAdapter(
        {
          server,
          path: this.path || '/',
          role: 'Universal',
          ...(this.options.accessToken ? { accessToken: this.options.accessToken } : {}),
          messageFormat: this.options.messageFormat,
          reportSelfMessage: this.options.reportSelfMessage,
        },
        this.dispatch,
      );
      // WS 复用同一个 server，传 `port` 只为满足类型；不会被监听。
      await this.ws.start();
    }

    const address = server.address();
    return typeof address === 'object' && address ? address.port : this.options.port;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const pathname = url.pathname.replace(/\/$/, '');

    if (
      !isAuthorized(this.options.accessToken, {
        header: request.headers.authorization,
        query: url.searchParams.get('access_token') ?? undefined,
      })
    ) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'failed', retcode: 1401, data: null }));
      return;
    }

    if (request.method === 'GET' && (pathname === this.path || pathname === '')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok', retcode: 0, data: { online: true } }));
      return;
    }

    if (request.method !== 'POST') {
      response.writeHead(405, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'failed', retcode: 1405, data: null }));
      return;
    }

    const action = pathname.slice(this.path.length).replace(/^\//, '');
    if (!action) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'failed', retcode: 1404, data: null }));
      return;
    }

    let params: JsonObject = {};
    try {
      params = await readJsonBody(request);
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'failed', retcode: 1400, data: null }));
      return;
    }

    const echo = url.searchParams.get('echo') ?? undefined;
    const result = await this.dispatch(action, params, echo ? { echo } : {});
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(result));
  }

  broadcast(event: JsonObject): void {
    this.ws?.broadcast(event);
  }

  async stop(): Promise<void> {
    await this.ws?.stop();
    this.ws = undefined;
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function readJsonBody(request: IncomingMessage): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      // 10 MiB 上限：HTTP 接口不该用来传整段媒体。
      if (size > 10 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? (JSON.parse(text) as JsonObject) : {});
      } catch (cause) {
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
    request.on('error', reject);
  });
}
