/**
 * 极简 SSE（`text/event-stream`）。
 *
 * 为什么不用 WebSocket：WebUI 是**单向推送**（服务端 → 页面），SSE 走普通 HTTP，
 * 不需要额外的升级握手与鉴权分支，也能复用同一套会话 cookie。
 *
 * 有界：每个连接有一个待发队列上限，超过就断开 —— 慢消费者不能把内存吃光
 * （与 OneBot 网络层的 `MAX_BUFFERED_BYTES` 同一口径）。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

const MAX_QUEUE_BYTES = 4 * 1024 * 1024;
const HEARTBEAT_MS = 15_000;

export interface SseClient {
  send(event: string, data: unknown): void;
  close(): void;
}

export function openSse(request: IncomingMessage, response: ServerResponse): SseClient {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    // 关掉 nginx 之类的代理缓冲（用户可能把控制台挂在自己反代后面）。
    'x-accel-buffering': 'no',
  });
  response.write(': connected\n\n');

  let closed = false;
  let queued = 0;

  const heartbeat = setInterval(() => {
    if (closed) return;
    response.write(': ping\n\n');
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
  };

  // 浏览器关页面 / 刷新会断开连接。
  request.on('close', cleanup);
  response.on('close', cleanup);

  return {
    send(event, data) {
      if (closed) return;
      let payload: string;
      try {
        payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      } catch {
        return; // 不可序列化的数据直接丢：推送通道不该因为一条脏数据断掉
      }
      const bytes = Buffer.byteLength(payload);
      if (queued + bytes > MAX_QUEUE_BYTES) {
        cleanup();
        response.end();
        return;
      }
      queued += bytes;
      response.write(payload, () => {
        queued = Math.max(0, queued - bytes);
      });
    },
    close() {
      cleanup();
      response.end();
    },
  };
}
