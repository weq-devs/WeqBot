/**
 * `set_group_add_request` 的注册与分发。
 *
 * 回归点：这条 action 曾经「有定义、有 requires，但后端没实装」—— 注册表把它
 * 静默跳过，客户端一调就是 1404。这里固定两件事：
 *   - 后端有 `setGroupAddRequest` → 注册；
 *   - 后端没有 → 跳过（1404），而不是注册了再崩。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { ActionRegistry } from '../src/action-registry';
import { registerActions } from '../src/actions';
import type { OneBotBackend } from '../src/backend';

function makeBackend(overrides: Partial<OneBotBackend> = {}): OneBotBackend {
  return {
    getLoginInfo: async () => ({ userId: 10001, nickname: 'bot' }),
    sendGroupMessage: async () => ({ sequence: 1 }),
    sendPrivateMessage: async () => ({ sequence: 2 }),
    recall: async () => {},
    ...overrides,
  };
}

test('后端实装 setGroupAddRequest 后 action 注册且参数校验生效', async () => {
  const calls: Array<{ flag: string; approve: boolean; reason: string }> = [];
  const backend = makeBackend({
    setGroupAddRequest: async (flag, approve, reason) => {
      calls.push({ flag, approve, reason });
    },
  });
  const registry = new ActionRegistry();
  const { registered, skipped } = registerActions(registry, backend);
  assert.ok(registered.includes('set_group_add_request'));
  assert.ok(!skipped.includes('set_group_add_request'));

  const response = await registry.call(
    'set_group_add_request',
    { flag: 'slreq:1:1:2:1:0', approve: true, reason: '' },
    {
      selfId: 10001,
      backend,
      messageFormat: 'array',
      startedAt: Date.now(),
      internSentMessageId: () => 1,
      resolveMessageMeta: () => null,
      resolveMessageEvent: () => null,
      internMessageEvent: () => 1,
      findLatestMessageAnchor: () => null,
    },
  );
  assert.equal(response.retcode, 0);
  assert.deepEqual(calls, [{ flag: 'slreq:1:1:2:1:0', approve: true, reason: '' }]);
});

test('缺少 flag / approve 时 1400，不调用后端', async () => {
  let called = 0;
  const backend = makeBackend({
    setGroupAddRequest: async () => {
      called += 1;
    },
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);
  const context = {
    selfId: 10001,
    backend,
    messageFormat: 'array' as const,
    startedAt: Date.now(),
    internSentMessageId: () => 1,
    resolveMessageMeta: () => null,
    resolveMessageEvent: () => null,
    internMessageEvent: () => 1,
    findLatestMessageAnchor: () => null,
  };

  const missingFlag = await registry.call('set_group_add_request', { approve: true }, context);
  assert.equal(missingFlag.retcode, 1400);
  const missingApprove = await registry.call('set_group_add_request', { flag: 'x' }, context);
  assert.equal(missingApprove.retcode, 1400);
  assert.equal(called, 0);
});

test('后端没实装时不注册（1404）', async () => {
  const registry = new ActionRegistry();
  const { skipped } = registerActions(registry, makeBackend());
  assert.ok(skipped.includes('set_group_add_request'));
  assert.equal(registry.has('set_group_add_request'), false);
});
