/**
 * 网络层测试：真实起 `ws` 服务端 + HTTP，跑一次 action 往返。
 *
 * 不 mock 传输 —— 这里要验的正是「协议帧能被真的收发」。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocket } from '../src/network/ws-module';
import { HttpServerAdapter } from '../src/network/http-server';
import { WsServerAdapter } from '../src/network/ws-server';
import type { ActionDispatcher } from '../src/adapter';
import type { JsonObject } from '../src/types';

function dispatcher(seen: JsonObject[] = []): ActionDispatcher {
  return async (action, params, options) => {
    seen.push(params);
    // 桩这里也回传 echo：模拟 ActionRegistry.call 的正确行为，顺带守住
    // 「WS 层确实把 echo 交给了 dispatcher」。
    const echo = options?.echo as JsonObject | undefined;
    const envelope = (base: { status: string; retcode: number; data: unknown }) =>
      echo === undefined ? base : { ...base, echo };
    if (action === 'echo_params') {
      return envelope({ status: 'ok', retcode: 0, data: params });
    }
    return envelope({ status: 'failed', retcode: 1404, data: null, wording: 'unknown' });
  };
}

function once<T>(setup: (resolve: (value: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve) => setup(resolve));
}

test('正向 WS：action 往返 + access token', async () => {
  const server = new WsServerAdapter(
    {
      port: 0,
      accessToken: 'secret',
      role: 'Universal',
      messageFormat: 'array',
      reportSelfMessage: true,
    },
    dispatcher(),
  );
  const port = await server.start();

  // 没 token 的连接会被握手拒绝：客户端拿不到 `open`。
  const unauthorizedOutcome = await once<string>((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/`);
    socket.on('open', () => {
      socket.terminate();
      resolve('opened');
    });
    socket.on('error', () => resolve('error'));
    socket.on('unexpected-response', (_request, response) =>
      resolve(`status ${response.statusCode}`),
    );
  });
  assert.notEqual(unauthorizedOutcome, 'opened', '无 token 不应握手成功');

  const socket = new WebSocket(`ws://127.0.0.1:${port}/?access_token=secret`);
  await once<void>((resolve) => socket.on('open', () => resolve()));

  const reply = await once<{ status: string; data: unknown; echo?: unknown }>((resolve) => {
    socket.once('message', (raw) => resolve(JSON.parse(raw.toString())));
    socket.send(JSON.stringify({ action: 'echo_params', params: { a: 1 }, echo: 'e1' }));
  });
  assert.equal(reply.status, 'ok');
  assert.deepEqual(reply.data, { a: 1 });
  // v11 客户端靠 echo 配对请求与响应；不回传的话，严格按 echo 过滤的客户端
  // 会一直等（真机上表现为「所有 action 都超时，但事件推送正常」）。
  assert.equal(reply.echo, 'e1');

  socket.terminate();
  await server.stop();

  // 停止后端口应释放：能重新起一个同端口的监听。
  const again = new WsServerAdapter(
    { port, messageFormat: 'array', reportSelfMessage: false },
    dispatcher(),
  );
  const reused = await again.start();
  assert.equal(reused, port);
  await again.stop();
});

test('正向 WS：角色为 Event 的连接不接受 action', async () => {
  const server = new WsServerAdapter(
    { port: 0, role: 'Event', messageFormat: 'array', reportSelfMessage: false },
    dispatcher(),
  );
  const port = await server.start();

  const socket = new WebSocket(`ws://127.0.0.1:${port}/`);
  await once<void>((resolve) => socket.on('open', () => resolve()));

  const closed = await once<number>((resolve) => {
    socket.on('close', (code) => resolve(code));
    socket.send(JSON.stringify({ action: 'echo_params', params: {} }));
  });
  assert.equal(closed, 1008);
  socket.terminate();
  await server.stop();
});

test('正向 WS：事件广播到 Universal 连接', async () => {
  const server = new WsServerAdapter(
    { port: 0, messageFormat: 'array', reportSelfMessage: false },
    dispatcher(),
  );
  const port = await server.start();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/`);
  await once<void>((resolve) => socket.on('open', () => resolve()));

  const received = once<{ post_type: string }>((resolve) => {
    socket.once('message', (raw) => resolve(JSON.parse(raw.toString())));
  });
  server.broadcast({ post_type: 'meta_event', meta_event_type: 'lifecycle' });
  assert.equal((await received).post_type, 'meta_event');

  socket.terminate();
  await server.stop();
});

test('HTTP：POST /<action> 返回 JSON，token 走 Bearer', async () => {
  const seen: JsonObject[] = [];
  const server = new HttpServerAdapter(
    {
      port: 0,
      accessToken: 'secret',
      messageFormat: 'array',
      reportSelfMessage: false,
    },
    dispatcher(seen),
  );
  const port = await server.start();

  const ok = await fetch(`http://127.0.0.1:${port}/echo_params`, {
    method: 'POST',
    headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
    body: JSON.stringify({ x: 2 }),
  });
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as { data: unknown };
  assert.deepEqual(body.data, { x: 2 });

  const unauthorized = await fetch(`http://127.0.0.1:${port}/echo_params`, {
    method: 'POST',
    body: '{}',
  });
  assert.equal(unauthorized.status, 401);

  const health = await fetch(`http://127.0.0.1:${port}/`, {
    headers: { authorization: 'Bearer secret' },
  });
  assert.equal(health.status, 200);

  await server.stop();
});
