/**
 * 适配器端到端：真起 WS 服务端，用真实客户端跑 action 与事件。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { TypedEventBus } from '@weqbot/common';
import { createOneBotAdapter } from '../src/adapter';
import type { OneBotBackend } from '../src/backend';
import { WebSocket } from '../src/network/ws-module';
import type { OneBotConfig } from '../src/types';

function config(port: number): OneBotConfig {
  return {
    networks: {
      httpServers: [],
      httpClients: [],
      wsClients: [],
      wsServers: [
        {
          name: 'test',
          port,
          role: 'Universal',
          messageFormat: 'array',
          reportSelfMessage: true,
        },
      ],
    },
  };
}

function backend(): OneBotBackend {
  return {
    getLoginInfo: async () => ({ userId: 10001, nickname: 'bot' }),
    sendGroupMessage: async () => ({ sequence: 101 }),
    sendPrivateMessage: async () => ({ sequence: 202 }),
    recall: async () => {},
    getFriendList: async () => [{ userId: 20002, nickname: 'friend', remark: '' }],
  };
}

function once<T>(setup: (resolve: (value: T) => void) => void, timeoutMs = 5000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待超时')), timeoutMs);
    timer.unref?.();
    setup((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

async function connect(url: string) {
  const socket = new WebSocket(url);
  await once<void>((resolve) => socket.on('open', () => resolve()));
  return { socket };
}

type Socket = {
  once(event: 'message', listener: (raw: Buffer) => void): unknown;
  send(data: string): void;
};

function callAction(
  socket: Socket,
  action: string,
  params: Record<string, unknown>,
): Promise<{ status: string; retcode: number; data: unknown }> {
  // 先把响应挂上再发送；服务端回包是异步的。
  const response = once<{ status: string; retcode: number; data: unknown }>((resolve) => {
    socket.once('message', (raw) => resolve(JSON.parse(raw.toString())));
  });
  socket.send(JSON.stringify({ action, params }));
  return response;
}

test('适配器：注册 action、响应调用、推送事件', async () => {
  const events = new TypedEventBus<BotEventMap>();
  const adapter = createOneBotAdapter({
    config: config(0),
    backend: backend(),
    selfId: 10001,
    events: {
      on: (event: string, listener: (value: never) => void) =>
        events.on(event as keyof BotEventMap, listener as never),
    } as never,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
  });

  await adapter.start();
  const port = adapter.port!;
  assert.ok(port > 0);
  assert.ok(adapter.actions().includes('send_group_msg'));
  assert.ok(!adapter.actions().includes('get_group_list'));

  const { socket } = await connect(`ws://127.0.0.1:${port}/`);
  const messages: Array<Record<string, unknown>> = [];
  socket.on('message', (raw) => messages.push(JSON.parse(raw.toString())));

  const sent = await callAction(socket, 'send_group_msg', { group_id: 20001, message: 'hi' });
  assert.equal(sent.status, 'ok');
  assert.ok((sent.data as { message_id: number }).message_id > 0);

  const friends = await callAction(socket, 'get_friend_list', {});
  assert.equal(friends.retcode, 0);
  assert.deepEqual(friends.data, [{ user_id: 20002, nickname: 'friend', remark: '' }]);

  const missing = await callAction(socket, 'get_group_list', {});
  assert.equal(missing.retcode, 1404);

  // 推一条消息事件，客户端应收到 `post_type: message`。
  const received = once<Record<string, unknown>>((resolve) => {
    const timer = setInterval(() => {
      const index = messages.findIndex((message) => message.post_type === 'message');
      if (index >= 0) {
        clearInterval(timer);
        resolve(messages[index]!);
      }
    }, 5);
    timer.unref?.();
  });
  events.emit('message', {
    messageId: '88',
    seq: 1,
    time: 1_700_000_000,
    scene: 'group',
    peer: { id: '55555' },
    sender: { id: '20002', name: '群友' },
    self: { uin: '10001' },
    elements: [{ kind: 'text', textContent: 'hello' }],
  });
  const post = await received;
  assert.equal(post.message_type, 'group');
  assert.equal(post.raw_message, 'hello');

  // lifecycle meta_event 在连接建立**之前**就发过了，晚连的客户端收不到；
  // 这是 OneBot 的正常语义（connect 通知的是启动时刻的在线者）。
  // 新连接能收到的是后续的 heartbeat —— 这条走 30s 定时器，测试里不阻塞等。

  socket.terminate();
  await adapter.stop();
});

test('适配器：敏感 action 即使后端实现也不出现', async () => {
  const events = new TypedEventBus<BotEventMap>();
  const adapter = createOneBotAdapter({
    config: config(0),
    backend: {
      ...backend(),
      // @ts-expect-error 故意塞一个后端没声明的方法，验证 deny-list 不靠后端类型。
      send_redbag: async () => ({}),
    },
    selfId: 10001,
    events: {
      on: (event: string, listener: (value: never) => void) =>
        events.on(event as keyof BotEventMap, listener as never),
    } as never,
  });
  await adapter.start();
  assert.ok(!adapter.actions().some((name) => name.includes('redbag')));
  await adapter.stop();
});

test('适配器：入站图片 / 语音的 url 由 resolver 补齐（带场景）', async () => {
  const events = new TypedEventBus<BotEventMap>();
  const seen: Array<{ kind: string; isGroup: boolean }> = [];
  const adapter = createOneBotAdapter({
    config: config(0),
    backend: backend(),
    selfId: 10001,
    events: {
      on: (event: string, listener: (value: never) => void) =>
        events.on(event as keyof BotEventMap, listener as never),
    } as never,
    imageUrlResolver: (element, isGroup) => {
      seen.push({ kind: String(element.kind), isGroup });
      return `https://cdn/img?token=${String(element.fileToken)}`;
    },
    mediaUrlResolver: (element, isGroup) => {
      seen.push({ kind: String(element.kind), isGroup });
      return `https://cdn/audio?token=${String(element.fileToken)}`;
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
  });

  await adapter.start();
  const { socket } = await connect(`ws://127.0.0.1:${adapter.port!}/`);
  const messages: Array<Record<string, unknown>> = [];
  socket.on('message', (raw) => messages.push(JSON.parse(raw.toString())));

  const received = once<Record<string, unknown>>((resolve) => {
    const timer = setInterval(() => {
      const index = messages.findIndex((message) => message.post_type === 'message');
      if (index >= 0) {
        clearInterval(timer);
        resolve(messages[index]!);
      }
    }, 5);
    timer.unref?.();
  });
  events.emit('message', {
    messageId: '99',
    seq: 2,
    time: 1_700_000_000,
    scene: 'group',
    peer: { id: '55555' },
    sender: { id: '20002', name: '群友' },
    self: { uin: '10001' },
    elements: [
      { kind: 'pic', fileToken: 'IMG', fileName: 'a.png' },
      { kind: 'ptt', fileToken: 'VOICE', fileName: 'b.amr' },
    ],
  });
  const post = await received;

  const segments = post.message as Array<{ type: string; data: { url: string } }>;
  assert.equal(segments[0]?.type, 'image');
  assert.equal(segments[0]?.data.url, 'https://cdn/img?token=IMG');
  assert.equal(segments[1]?.type, 'record');
  assert.equal(segments[1]?.data.url, 'https://cdn/audio?token=VOICE');
  // 场景要透传：rkey 的 type 与 appid 都按群 / 私聊分叉。
  assert.deepEqual(seen, [
    { kind: 'pic', isGroup: true },
    { kind: 'ptt', isGroup: true },
  ]);

  socket.terminate();
  await adapter.stop();
});
