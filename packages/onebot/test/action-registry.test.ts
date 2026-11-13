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
    internSentMessageId: () => 42,
    resolveMessageMeta: () => null,
    resolveMessageEvent: () => null,
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

test('敏感能力被 deny-list 拦住，即使后端实现了', () => {
  const names = ALL_ACTIONS.map((entry) => entry.definition.name);
  for (const name of names) {
    assert.ok(!isDeniedAction(name), `${name} 不应出现在 action 表里`);
  }
  assert.ok(isDeniedAction('send_redbag'));
  assert.ok(isDeniedAction('group_send_red_packet'));
  assert.ok(!isDeniedAction('send_group_msg'));
});
