/**
 * 自定义扩展 action 的契约测试：能力门控、参数校验、segment → 协议元素。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { ActionRegistry, type ActionContext } from '../src/action-registry';
import { registerActions } from '../src/actions';
import type { OneBotBackend } from '../src/backend';
import { segmentsToElements } from '../src/segments';

function makeBackend(overrides: Partial<OneBotBackend> = {}): OneBotBackend {
  return {
    getLoginInfo: async () => ({ userId: 10001, nickname: 'bot' }),
    sendGroupMessage: async () => ({ sequence: 1 }),
    sendPrivateMessage: async () => ({ sequence: 2 }),
    recall: async () => {},
    ...overrides,
  };
}

function makeContext(backend: OneBotBackend): ActionContext {
  return {
    selfId: 10001,
    backend,
    messageFormat: 'array',
    startedAt: Date.now(),
    internSentMessageId: () => 42,
    resolveMessageMeta: () => null,
    resolveMessageEvent: () => null,
    internMessageEvent: () => 43,
    findLatestMessageAnchor: () => null,
  };
}

test('后端没有对应能力时，自定义扩展 action 不注册', () => {
  const registry = new ActionRegistry();
  const { skipped } = registerActions(registry, makeBackend());

  for (const name of [
    'get_dress_url',
    'ftf2ttf',
    'get_group_gift_list',
    'send_location_share',
    'update_location_share',
    'get_qq_show_url',
  ]) {
    assert.ok(skipped.includes(name), `${name} 应该被跳过`);
    assert.equal(registry.has(name), false);
  }

  // 发送类只依赖基础 send*，永远可注册。
  assert.ok(registry.has('send_private_flash_photo'));
  assert.ok(registry.has('send_emoji_bounce'));
  assert.ok(registry.has('send_bubble_msg'));
});

test('后端补上能力后，自定义扩展 action 全部出现', () => {
  const backend = makeBackend({
    dress: { getResources: async () => ({}) },
    font: { convert: async () => ({ inputPath: '', outputPath: '', pipelineVersion: 0 }) },
    misc: {
      requestDecryptKey: async () => '',
      getGroupGiftList: async () => ({}),
    },
    location: {
      start: async () => ({ code: 0, message: '', send: { sequence: 1 } }),
      report: async () => ({ code: 0, message: '', interval: 2 }),
    },
    profile: {
      setProfile: async () => {},
      setAvatar: async () => {},
      getProfileLike: async () => {
        throw new Error('not used');
      },
      setOnlineStatus: async () => {},
      setDiyOnlineStatus: async () => {},
      setSelfLongNick: async () => {},
      setInputStatus: async () => {},
      getQqShowUrl: async () => ({ uin: 1, hasShow: false, url: '' }),
    },
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);

  for (const name of [
    'get_dress_url',
    'ftf2ttf',
    'send_private_flash_photo',
    'send_emoji_bounce',
    'send_bubble_msg',
    'get_group_gift_list',
    'send_location_share',
    'update_location_share',
    'get_qq_show_url',
  ]) {
    assert.ok(registry.has(name), `${name} 应该注册`);
  }
});

test('get_dress_url 按类型转发 item_id', async () => {
  const calls: unknown[] = [];
  const backend = makeBackend({
    dress: {
      getResources: async (params) => {
        calls.push(params);
        return { ok: true };
      },
    },
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);
  const ctx = makeContext(backend);

  const ok = await registry.call('get_dress_url', { type: 'font', item_id: 10060 }, ctx);
  assert.equal(ok.status, 'ok');
  assert.deepEqual(calls[0], { kind: 'font', itemId: 10060 });

  const bad = await registry.call('get_dress_url', { type: 'hat', item_id: 1 }, ctx);
  assert.equal(bad.retcode, 1400);
});

test('ftf2ttf 转发文件与转换参数', async () => {
  const calls: unknown[] = [];
  const backend = makeBackend({
    font: {
      convert: async (params) => {
        calls.push(params);
        return { inputPath: params.input, outputPath: params.output ?? '', pipelineVersion: 2 };
      },
    },
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);

  const response = await registry.call(
    'ftf2ttf',
    { file: '/tmp/a.ftf', output: '/tmp/a.ttf', color: true, check_ots: false },
    makeContext(backend),
  );
  assert.equal(response.status, 'ok');
  assert.deepEqual(calls[0], {
    input: '/tmp/a.ftf',
    output: '/tmp/a.ttf',
    assetsDir: undefined,
    color: true,
    colorChars: undefined,
    checkOts: false,
  });
});

test('send_private_flash_photo 发私聊并返回 message_id', async () => {
  const sent: unknown[] = [];
  const backend = makeBackend({
    sendPrivateMessage: async (userId, message) => {
      sent.push({ userId, message });
      return { sequence: 7, clientSequence: 8, random: 9, timestamp: 10 };
    },
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);

  const response = await registry.call(
    'send_private_flash_photo',
    { user_id: 20002, file: '/tmp/a.jpg' },
    makeContext(backend),
  );
  assert.deepEqual(response.data, { message_id: 42 });
  assert.deepEqual(sent[0], {
    userId: 20002,
    message: [{ type: 'flash_photo', data: { file: '/tmp/a.jpg' } }],
  });
});

test('send_emoji_bounce / send_bubble_msg 路由到群或私聊', async () => {
  const group: unknown[] = [];
  const priv: unknown[] = [];
  const backend = makeBackend({
    sendGroupMessage: async (groupId, message) => {
      group.push({ groupId, message });
      return { sequence: 1 };
    },
    sendPrivateMessage: async (userId, message) => {
      priv.push({ userId, message });
      return { sequence: 2 };
    },
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);
  const ctx = makeContext(backend);

  const bounce = await registry.call(
    'send_emoji_bounce',
    { group_id: 30003, face_id: 182, count: 3, name: '笑哭' },
    ctx,
  );
  assert.equal(bounce.status, 'ok');
  assert.deepEqual(group[0], {
    groupId: 30003,
    message: [{ type: 'emoji_bounce', data: { face_id: 182, count: 3, name: '笑哭' } }],
  });

  const bubble = await registry.call(
    'send_bubble_msg',
    { user_id: 20002, file: '/tmp/a.mp4', width: 720, height: 1280 },
    ctx,
  );
  assert.equal(bubble.status, 'ok');
  assert.deepEqual(priv[0], {
    userId: 20002,
    message: [{ type: 'bubble_video', data: { file: '/tmp/a.mp4', width: 720, height: 1280 } }],
  });

  const missingTarget = await registry.call('send_emoji_bounce', { face_id: 1 }, ctx);
  assert.equal(missingTarget.retcode, 1400);
});

test('位置共享 action 转发坐标并返回 message_id', async () => {
  const starts: unknown[] = [];
  const reports: unknown[] = [];
  const backend = makeBackend({
    location: {
      start: async (params) => {
        starts.push(params);
        return { code: 0, message: 'ok', send: { sequence: 5 } };
      },
      report: async (params) => {
        reports.push(params);
        return { code: 0, message: 'ok', interval: 2 };
      },
    },
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);
  const ctx = makeContext(backend);

  const start = await registry.call(
    'send_location_share',
    { group_id: 30003, longitude: 116.397, latitude: 39.908 },
    ctx,
  );
  assert.deepEqual(start.data, { code: 0, message: 'ok', message_id: 42 });
  assert.deepEqual(starts[0], {
    groupId: 30003,
    longitude: 116.397,
    latitude: 39.908,
  });

  const report = await registry.call(
    'update_location_share',
    { user_id: 20002, longitude: 116.4, latitude: 39.9, extra: 100 },
    ctx,
  );
  assert.deepEqual(report.data, { code: 0, message: 'ok', interval: 2 });
  assert.deepEqual(reports[0], {
    userId: 20002,
    longitude: 116.4,
    latitude: 39.9,
    extra: 100,
  });

  const invalid = await registry.call(
    'update_location_share',
    { user_id: 20002, longitude: 181, latitude: 0 },
    ctx,
  );
  assert.equal(invalid.retcode, 1400);
});

test('get_qq_show_url / get_group_gift_list 转发参数', async () => {
  const shows: Array<number | undefined> = [];
  const gifts: number[] = [];
  const backend = makeBackend({
    profile: {
      setProfile: async () => {},
      setAvatar: async () => {},
      getProfileLike: async () => {
        throw new Error('not used');
      },
      setOnlineStatus: async () => {},
      setDiyOnlineStatus: async () => {},
      setSelfLongNick: async () => {},
      setInputStatus: async () => {},
      getQqShowUrl: async (userId) => {
        shows.push(userId);
        return { uin: userId ?? 10001, hasShow: true, url: 'https://example.com/a.png' };
      },
    },
    misc: {
      requestDecryptKey: async () => '',
      getGroupGiftList: async (groupId) => {
        gifts.push(groupId);
        return { tabs: [] };
      },
    },
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);
  const ctx = makeContext(backend);

  assert.equal((await registry.call('get_qq_show_url', {}, ctx)).status, 'ok');
  assert.equal((await registry.call('get_qq_show_url', { user_id: 20002 }, ctx)).status, 'ok');
  assert.deepEqual(shows, [undefined, 20002]);

  assert.equal((await registry.call('get_group_gift_list', { group_id: 30003 }, ctx)).status, 'ok');
  assert.deepEqual(gifts, [30003]);
});

test('新增 segment 转成协议出站元素', async () => {
  const elements = await segmentsToElements([
    { type: 'flash_photo', data: { file: '/tmp/a.jpg' } },
    { type: 'emoji_bounce', data: { face_id: 182, count: 10, name: '笑哭' } },
    {
      type: 'bubble_video',
      data: {
        file: '/tmp/a.mp4',
        thumb: '/tmp/t.jpg',
        duration: 5,
        width: 720,
        height: 1280,
        template_name: 'video_penguin_dance',
      },
    },
  ]);

  assert.deepEqual(elements, [
    { kind: 'flashPhoto', source: '/tmp/a.jpg' },
    { kind: 'emojiBounce', faceId: 182, count: 10, name: '笑哭' },
    {
      kind: 'bubbleVideo',
      source: '/tmp/a.mp4',
      thumb: '/tmp/t.jpg',
      duration: 5,
      width: 720,
      height: 1280,
      templateName: 'video_penguin_dance',
    },
  ]);
});
