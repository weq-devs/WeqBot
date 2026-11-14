/**
 * action 注册与分发的契约测试。
 *
 * 重点：
 *   1. 后端没实现的能力 → action 不注册 → 调用返回 1404；
 *   2. 参数错误 → 1400；业务错误 → 100；
 *   3. **敏感能力永不注册**（红包 / 转账）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { ActionRegistry, isDeniedAction } from '../src/action-registry';
import { ALL_ACTIONS, registerActions } from '../src/actions';
import type { OneBotBackend } from '../src/backend';
import type { ActionContext } from '../src/action-registry';

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

test('只注册后端实现了的 action', () => {
  const registry = new ActionRegistry();
  const { registered, skipped } = registerActions(registry, makeBackend());
  assert.ok(registered.includes('send_group_msg'));
  assert.ok(registered.includes('send_private_msg'));
  assert.ok(registered.includes('get_login_info'));
  // 后端没有 getFriendList，所以这个 action 不注册。
  assert.ok(skipped.includes('get_friend_list'));
  assert.ok(!registry.has('get_friend_list'));
});

test('后端补上能力后，对应 action 自动出现', () => {
  const registry = new ActionRegistry();
  const backend = makeBackend({ getFriendList: async () => [] });
  registerActions(registry, backend);
  assert.ok(registry.has('get_friend_list'));
});

test('未注册的 action 返回 1404', async () => {
  const registry = new ActionRegistry();
  registerActions(registry, makeBackend());
  const response = await registry.call('get_friend_list', {}, makeContext(makeBackend()));
  assert.equal(response.retcode, 1404);
  assert.equal(response.status, 'failed');
});

test('参数错误返回 1400', async () => {
  const registry = new ActionRegistry();
  registerActions(registry, makeBackend());
  const response = await registry.call(
    'send_group_msg',
    { group_id: 0, message: 'x' },
    makeContext(makeBackend()),
  );
  assert.equal(response.retcode, 1400);
});

test('业务错误返回 100', async () => {
  const registry = new ActionRegistry();
  const backend = makeBackend({
    sendGroupMessage: async () => {
      throw new Error('发送失败');
    },
  });
  registerActions(registry, backend);
  const response = await registry.call(
    'send_group_msg',
    { group_id: 20001, message: 'x' },
    makeContext(backend),
  );
  assert.equal(response.retcode, 100);
  assert.match(String(response.wording), /发送失败/);
});

test('send_group_msg 成功返回分配的 message_id', async () => {
  const registry = new ActionRegistry();
  const backend = makeBackend();
  registerActions(registry, backend);
  const response = await registry.call(
    'send_group_msg',
    { group_id: 20001, message: 'hi' },
    makeContext(backend),
  );
  assert.equal(response.status, 'ok');
  assert.deepEqual(response.data, { message_id: 42 });
});

test('get_status 的 time 来自适配器启动时刻', async () => {
  const registry = new ActionRegistry();
  const backend = makeBackend({ getStatus: async () => ({ online: true, good: false }) });
  registerActions(registry, backend);
  const ctx = { ...makeContext(backend), startedAt: Date.now() - 5_000 };
  const response = await registry.call('get_status', {}, ctx);

  assert.equal(response.status, 'ok');
  const data = response.data as { online: boolean; good: boolean; time: number };
  assert.equal(data.online, true);
  assert.equal(data.good, false);
  assert.ok(data.time >= 4 && data.time <= 6, `time 应为 ~5 秒，实际 ${data.time}`);
});

test('后端没实现 getStatus 时也按在线回答', async () => {
  const registry = new ActionRegistry();
  registerActions(registry, makeBackend());
  const response = await registry.call('get_status', {}, makeContext(makeBackend()));
  assert.equal(response.status, 'ok');
  const data = response.data as { online: boolean; good: boolean; time: number };
  assert.equal(data.online, true);
  assert.equal(data.good, false);
  // 刚启动，运行秒数还在 0 附近。
  assert.ok(data.time <= 1, `time 应接近 0，实际 ${data.time}`);
});

test('get_version_info 不需要后端能力', async () => {
  const registry = new ActionRegistry();
  registerActions(registry, makeBackend());
  const response = await registry.call('get_version_info', {}, makeContext(makeBackend()));
  assert.equal(response.status, 'ok');
  assert.deepEqual(response.data, {
    app_name: 'WeqBot',
    app_version: '0.0.0',
    protocol_version: 'v11',
  });
});

test('set_group_special_title：duration 语义与 uid 依赖', async () => {
  const calls: Array<{ groupId: number; userId: number; title: string; duration?: number }> = [];
  const backend = makeBackend({
    setGroupSpecialTitle: async (groupId, userId, title, duration) => {
      calls.push({ groupId, userId, title, ...(duration !== undefined ? { duration } : {}) });
    },
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);
  const ctx = makeContext(backend);

  const permanent = await registry.call(
    'set_group_special_title',
    { group_id: 20001, user_id: 30003, special_title: '元老' },
    ctx,
  );
  assert.equal(permanent.status, 'ok');
  assert.deepEqual(calls[0], { groupId: 20001, userId: 30003, title: '元老' });

  // `duration: -1` 是 OneBot 的「永久」，不该被当成非法参数。
  const explicitPermanent = await registry.call(
    'set_group_special_title',
    { group_id: 20001, user_id: 30003, special_title: '元老', duration: -1 },
    ctx,
  );
  assert.equal(explicitPermanent.status, 'ok');
  assert.equal(calls[1]?.duration, undefined);

  const timed = await registry.call(
    'set_group_special_title',
    { group_id: 20001, user_id: 30003, special_title: '限时', duration: 3600 },
    ctx,
  );
  assert.equal(timed.status, 'ok');
  assert.equal(calls[2]?.duration, 3600);

  const invalid = await registry.call(
    'set_group_special_title',
    { group_id: 20001, user_id: 30003, special_title: 'x', duration: -2 },
    ctx,
  );
  assert.equal(invalid.retcode, 1400);
});

test('敏感能力被 deny-list 拦住，即使后端实现了', () => {
  const names = ALL_ACTIONS.map((entry) => entry.definition.name);
  for (const name of names) {
    assert.ok(!isDeniedAction(name), `${name} 不应出现在 action 表里`);
  }
  assert.ok(isDeniedAction('send_redbag'));
  assert.ok(isDeniedAction('group_send_red_packet'));
  assert.ok(!isDeniedAction('send_group_msg'));
});

test('echo 原样回传（成功 / 参数错 / 未知 action 三条路径）', async () => {
  const registry = new ActionRegistry();
  registerActions(registry, makeBackend());
  const ctx = makeContext(makeBackend());

  const ok = await registry.call('send_group_msg', { group_id: 20001, message: 'hi' }, ctx, 'e1');
  assert.equal(ok.status, 'ok');
  assert.equal(ok.echo, 'e1');

  const bad = await registry.call('send_group_msg', { group_id: 0, message: 'x' }, ctx, 'e2');
  assert.equal(bad.retcode, 1400);
  assert.equal(bad.echo, 'e2', '参数错误也要回 echo，否则客户端分不清是哪条请求');

  const unknown = await registry.call('no_such_action', {}, ctx, 'e3');
  assert.equal(unknown.retcode, 1404);
  assert.equal(unknown.echo, 'e3');
});

test('没传 echo 时响应里不出现 echo 键', async () => {
  const registry = new ActionRegistry();
  registerActions(registry, makeBackend());
  const response = await registry.call(
    'send_group_msg',
    { group_id: 1, message: 'x' },
    makeContext(makeBackend()),
  );
  assert.equal(Object.hasOwn(response, 'echo'), false);
});
