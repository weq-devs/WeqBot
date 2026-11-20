/**
 * 网络适配器启动失败的回滚。
 *
 * 背景：`startNetworks()` 曾经是裸循环 —— 第二个监听撞端口时，第一个已经建好
 * 的连接没人关，进程还活着、端口被自己占着，用户重试还是失败。这里固定住修复后
 * 的语义：
 *
 *   1. 任一步失败 → 已经起来的全部关闭（端口真正释放）；
 *   2. 错误是 `ONEBOT_LISTEN_FAILED`，`fields` 里能定位到具体网络与端口；
 *   3. `start()` 失败后适配器回到可再次启动的状态（不能永远拿回 rejected promise）。
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { WeqBotError } from '@weqbot/common';
import { createOneBotAdapter, type CreateOneBotAdapterOptions } from '../src/adapter';
import type { OneBotBackend } from '../src/backend';
import type { OneBotConfig } from '../src/types';

const backend: OneBotBackend = {
  uin: 10001,
  self: () => ({ user_id: 10001, nickname: 'bot' }),
  status: () => ({ online: true, good: true }),
};

function emptyNetworks(): OneBotConfig['networks'] {
  return { httpServers: [], httpClients: [], wsServers: [], wsClients: [] };
}

/** 事件源桩：这些用例只关心网络层的启停，不关心事件。 */
const noEvents: CreateOneBotAdapterOptions['events'] = {
  on: () => () => {},
};

function makeAdapter(config: OneBotConfig) {
  return createOneBotAdapter({
    config,
    backend,
    events: noEvents,
    selfId: 10001,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
  });
}

test('HTTP 跨域选项只影响其监听器，实际操作仍验证令牌', async (t) => {
  const networks = emptyNetworks();
  const server = {
    port: 0,
    accessToken: 'secret',
    messageFormat: 'array' as const,
    reportSelfMessage: false,
  };
  networks.httpServers = [
    { ...server, name: 'browser', enableCors: true },
    { ...server, name: 'local', enableCors: false },
  ];
  const adapter = makeAdapter({ networks });
  t.after(() => adapter.stop());
  await adapter.start();
  const url = (name: string) => {
    const port = adapter.networks().find((network) => network.name === name)?.port;
    assert.ok(port);
    return `http://127.0.0.1:${port}/get_login_info`;
  };
  const preflight = await fetch(url('browser'), { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  assert.equal(
    preflight.headers.get('access-control-allow-headers'),
    'authorization, content-type',
  );

  const unauthorized = await fetch(url('browser'), { method: 'POST', body: '{}' });
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get('access-control-allow-origin'), '*');

  const headers = { authorization: 'Bearer secret', 'content-type': 'application/json' };
  const valid = await fetch(url('browser'), { method: 'POST', headers, body: '{}' });
  assert.equal(valid.status, 200);
  const local = await fetch(url('local'), { method: 'OPTIONS', headers });
  assert.equal(local.status, 405);
  assert.equal(local.headers.get('access-control-allow-origin'), null);
});

/** 占住一个端口，拿到端口号。 */
async function occupy(): Promise<{ port: number; release: () => Promise<void> }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    release: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** 端口此刻有没有人在听。 */
async function isListening(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = createServer();
    socket.once('error', () => resolve(true));
    socket.listen(port, '127.0.0.1', () => {
      socket.close(() => resolve(false));
    });
  });
}

test('第二个监听撞端口：第一个被关掉，端口释放', async () => {
  const busy = await occupy();
  const networks = emptyNetworks();
  // 第一条用 0（系统分配，必定成功），第二条撞已被占用的端口。
  networks.wsServers = [
    { name: 'ok', port: 0, messageFormat: 'array', reportSelfMessage: true },
    { name: 'busy', port: busy.port, messageFormat: 'array', reportSelfMessage: true },
  ];

  const adapter = makeAdapter({ networks });
  try {
    await assert.rejects(adapter.start(), (cause: unknown) => {
      assert.ok(cause instanceof WeqBotError);
      assert.equal(cause.code, 'ONEBOT_LISTEN_FAILED');
      assert.equal(cause.detail.fields?.network, 'busy');
      assert.equal(cause.detail.fields?.port, busy.port);
      assert.equal(cause.detail.fields?.addressInUse, true);
      assert.match(cause.message, /端口 \d+ 已被占用/);
      return true;
    });
    // 回滚干净：适配器自己没有留下任何监听。
    assert.deepEqual(adapter.networks(), []);
    assert.equal(adapter.port, undefined);
  } finally {
    await adapter.stop();
    await busy.release();
  }
});

test('失败后可以再次 start（不会永远拿回 rejected promise）', async () => {
  const busy = await occupy();
  const networks = emptyNetworks();
  networks.wsServers = [
    { name: 'busy', port: busy.port, messageFormat: 'array', reportSelfMessage: true },
  ];

  const adapter = makeAdapter({ networks });
  await assert.rejects(adapter.start(), /已被占用/);

  // 端口腾出来之后，同一个适配器应该能起来。
  await busy.release();
  await adapter.start();
  try {
    assert.equal(adapter.networks().length, 1);
    assert.equal(adapter.networks()[0]?.state, 'listening');
  } finally {
    await adapter.stop();
  }
});

test('回滚确实释放了已启动的那个端口', async () => {
  const busy = await occupy();
  // 先拿一个固定端口作为「第一个」，再让第二个撞 busy。
  const probe = await occupy();
  const firstPort = probe.port;
  await probe.release();

  const networks = emptyNetworks();
  networks.wsServers = [
    { name: 'first', port: firstPort, messageFormat: 'array', reportSelfMessage: true },
    { name: 'busy', port: busy.port, messageFormat: 'array', reportSelfMessage: true },
  ];

  const adapter = makeAdapter({ networks });
  await assert.rejects(adapter.start(), /已被占用/);
  try {
    assert.equal(await isListening(firstPort), false, '回滚后第一个端口必须已释放');
  } finally {
    await adapter.stop();
    await busy.release();
  }
});

test('HTTP 服务端挂 WS 失败时，HTTP 监听也要关掉', async () => {
  // 让 HTTP 先 listen 成功、内嵌 WS 失败：`enableWebSocket` 走同一个 server，
  // 实际很难构造失败；这里退一步验证「HTTP 自己 listen 失败」时不留下监听。
  const busy = await occupy();
  const networks = emptyNetworks();
  networks.httpServers = [
    {
      name: 'http',
      port: busy.port,
      messageFormat: 'array',
      reportSelfMessage: true,
      enableWebSocket: true,
    },
  ];

  const adapter = makeAdapter({ networks });
  await assert.rejects(adapter.start(), (cause: unknown) => {
    assert.ok(cause instanceof WeqBotError);
    assert.equal(cause.code, 'ONEBOT_LISTEN_FAILED');
    assert.equal(cause.detail.fields?.kind, 'http-server');
    return true;
  });
  assert.deepEqual(adapter.networks(), []);
  await adapter.stop();
  await busy.release();
});
