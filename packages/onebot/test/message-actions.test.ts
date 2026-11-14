/**
 * 第 1 批 message action（历史 / 合并转发 / 已读 / 收藏表情）的注册与分发契约。
 *
 * 重点：
 *   1. 后端没有对应分组能力时整组 action 不注册（1404），不会「注册了再崩」；
 *   2. 返回字段名照抄 SnowLuma（`res_id` / `forward_id` / `messages` / `message_seq`）；
 *   3. 无历史锚点时明确失败，不返回伪造的空历史；
 *   4. 参数校验边界（count 负数、转发目标二选一、空节点）走 1400。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { ActionRegistry, type ActionContext } from '../src/action-registry';
import { registerActions } from '../src/actions';
import type { ForwardNode, HistoryMessage, OneBotBackend } from '../src/backend';

function makeBackend(overrides: Partial<OneBotBackend> = {}): OneBotBackend {
  return {
    getLoginInfo: async () => ({ userId: 10001, nickname: 'bot' }),
    sendGroupMessage: async () => ({ sequence: 11 }),
    sendPrivateMessage: async () => ({ sequence: 12 }),
    recall: async () => {},
    ...overrides,
  };
}

interface MetaStub {
  isGroup: boolean;
  targetId: number;
  sequence: number;
  ntSequence?: number;
}

interface ContextOptions {
  meta?: MetaStub;
  event?: Record<string, unknown>;
  latest?: number;
  onIntern?: (params: {
    isGroup: boolean;
    targetId: number;
    sequence: number;
    ntSequence?: number;
    wireId: string;
  }) => void;
}

function makeContext(backend: OneBotBackend, options: ContextOptions = {}): ActionContext {
  return {
    selfId: 10001,
    backend,
    messageFormat: 'array',
    startedAt: Date.now(),
    internSentMessageId: () => 42,
    resolveMessageMeta: () =>
      options.meta
        ? {
            isGroup: options.meta.isGroup,
            targetId: options.meta.targetId,
            sequence: options.meta.sequence,
            ...(options.meta.ntSequence !== undefined
              ? { ntSequence: options.meta.ntSequence }
              : {}),
            clientSequence: 0,
            random: 0,
            timestamp: 0,
          }
        : null,
    resolveMessageEvent: () => options.event ?? null,
    internMessageEvent: (params) => {
      options.onIntern?.(params);
      return 777;
    },
    findLatestMessageAnchor: () => options.latest ?? null,
  };
}

const historyItem: HistoryMessage = {
  sequence: 100,
  wireId: '9007199254740993',
  time: 1_700_000_000,
  senderId: 20002,
  senderName: '群友',
  message: [{ type: 'text', data: { text: '历史消息' } }],
};

function forwardBackend(calls: {
  upload?: Array<{ groupId?: number; userId?: number; nodes: ForwardNode[] }>;
  send?: Array<{ groupId?: number; userId?: number; nodes: ForwardNode[] }>;
  fetched?: string[];
  forwarded?: Array<{ groupId?: number; userId?: number }>;
}): NonNullable<OneBotBackend['forward']> {
  calls.upload ??= [];
  calls.send ??= [];
  calls.fetched ??= [];
  calls.forwarded ??= [];
  return {
    uploadForward: async (params) => {
      calls.upload?.push(params);
      return { resId: 'res-upload' };
    },
    sendForward: async (params) => {
      calls.send?.push(params);
      return { resId: 'res-send', send: { sequence: 31 } };
    },
    getForwardMessage: async (resId) => {
      calls.fetched?.push(resId);
      return [
        {
          userId: 20002,
          nickname: '群友',
          time: 1_700_000_000,
          messageId: -123,
          sequence: 66,
          groupId: 20001,
          message: [{ type: 'text', data: { text: '转发内容' } }],
        },
      ];
    },
    forwardSingleMessage: async (params) => {
      calls.forwarded?.push(params);
      return { sequence: 41 };
    },
  };
}

function readReportBackend(marks: { groups: number[]; privates: number[] }) {
  return {
    markGroupRead: async (groupId: number) => {
      marks.groups.push(groupId);
    },
    markPrivateRead: async (userId: number) => {
      marks.privates.push(userId);
    },
  };
}

function customFaceBackend() {
  return {
    listCustomFaces: async () => ['u_1_0_0_0_ABC_0_0'],
    getCustomFaceDetail: async () => [],
    modifyCustomFace: async () => {},
    moveCustomFaceToFront: async () => {},
    deleteCustomFace: async () => {},
    resolveCustomFaceUrl: async (identifier: string) => ({
      emojiId: identifier,
      md5: 'A'.repeat(32),
      url: `https://p.qpic.cn/qq_expression/10001/${identifier}/0`,
    }),
  };
}

test('没有 history / forward / readReport 能力时对应 action 不注册', async () => {
  const registry = new ActionRegistry();
  const { skipped } = registerActions(registry, makeBackend());
  for (const name of [
    'get_group_msg_history',
    'get_friend_msg_history',
    'get_forward_msg',
    'upload_forward_msg',
    'send_forward_msg',
    'send_group_forward_msg',
    'send_private_forward_msg',
    'mark_group_msg_as_read',
    'mark_private_msg_as_read',
    'mark_msg_as_read',
    'forward_friend_single_msg',
    'forward_group_single_msg',
    'send_custom_face',
  ]) {
    assert.ok(skipped.includes(name), `${name} 应被跳过`);
  }

  const response = await registry.call(
    'get_group_msg_history',
    { group_id: 20001 },
    makeContext(makeBackend()),
  );
  assert.equal(response.retcode, 1404);
});

test('群历史：锚点解析 + 字段名 + message_id 分配', async () => {
  let interned: { sequence: number; wireId: string } | null = null;
  let requested: { groupId: number; anchorSequence: number; count: number } | null = null;
  const history: NonNullable<OneBotBackend['history']> = {
    getGroupHistory: async (params) => {
      requested = params;
      return [historyItem];
    },
    getPrivateHistory: async () => [],
  };
  const backend = makeBackend({ history });
  const registry = new ActionRegistry();
  registerActions(registry, backend);

  const response = await registry.call(
    'get_group_msg_history',
    { group_id: 20001, message_id: 5, count: 20 },
    makeContext(backend, {
      meta: { isGroup: true, targetId: 20001, sequence: 99 },
      onIntern: (params) => {
        interned = { sequence: params.sequence, wireId: params.wireId };
      },
    }),
  );

  assert.equal(response.status, 'ok');
  assert.deepEqual(requested, {
    groupId: 20001,
    anchorSequence: 99,
    count: 20,
    reverseOrder: true,
  });
  const data = response.data as { messages: Array<Record<string, unknown>> };
  assert.equal(data.messages[0]!.message_id, 777);
  assert.equal(data.messages[0]!.message_seq, 100);
  assert.equal(data.messages[0]!.group_id, 20001);
  assert.equal(data.messages[0]!.raw_message, '历史消息');
  assert.deepEqual(data.messages[0]!.sender, {
    user_id: 20002,
    nickname: '群友',
    sex: 'unknown',
    age: 0,
  });
  assert.deepEqual(interned, { sequence: 100, wireId: '9007199254740993' });
});

test('历史：没有锚点时交给后端探测；锚点不属于该会话返回空列表；count 负数 1400', async () => {
  let probed = false;
  const history: NonNullable<OneBotBackend['history']> = {
    getGroupHistory: async (params) => {
      probed = params.anchorSequence === undefined;
      return [historyItem];
    },
    getPrivateHistory: async () => [],
  };
  const backend = makeBackend({ history });
  const registry = new ActionRegistry();
  registerActions(registry, backend);

  const missing = await registry.call(
    'get_group_msg_history',
    { group_id: 20001 },
    makeContext(backend),
  );
  assert.equal(missing.status, 'ok');
  assert.equal(probed, true);

  const mismatched = await registry.call(
    'get_group_msg_history',
    { group_id: 20001, message_id: 5 },
    makeContext(backend, { meta: { isGroup: true, targetId: 99999, sequence: 1 } }),
  );
  assert.equal(mismatched.status, 'ok');
  assert.deepEqual(mismatched.data, { messages: [] });

  const invalid = await registry.call(
    'get_group_msg_history',
    { group_id: 20001, count: -1 },
    makeContext(backend, { latest: 10 }),
  );
  assert.equal(invalid.retcode, 1400);
});

test('私聊历史用 ntSequence 当锚点，返回私聊字段', async () => {
  let requested: { userId: number; anchorSequence: number } | null = null;
  const backend = makeBackend({
    history: {
      getGroupHistory: async () => [],
      getPrivateHistory: async (params) => {
        requested = params;
        return [{ ...historyItem, sequence: 55 }];
      },
    },
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);

  const response = await registry.call(
    'get_friend_msg_history',
    { user_id: 20002, message_id: 6 },
    makeContext(backend, {
      meta: { isGroup: false, targetId: 20002, sequence: 7, ntSequence: 55 },
    }),
  );

  assert.equal(response.status, 'ok');
  assert.deepEqual(requested, {
    userId: 20002,
    anchorSequence: 55,
    count: 20,
    reverseOrder: true,
  });
  const data = response.data as { messages: Array<Record<string, unknown>> };
  assert.equal(data.messages[0]!.message_type, 'private');
  assert.equal(data.messages[0]!.group_id, undefined);
});

test('发送群合并转发：节点解析 + res_id / forward_id / message_id', async () => {
  const calls: { send?: Array<{ groupId?: number; nodes: ForwardNode[] }> } = {};
  const backend = makeBackend({ forward: forwardBackend(calls) });
  const registry = new ActionRegistry();
  registerActions(registry, backend);

  const response = await registry.call(
    'send_group_forward_msg',
    {
      group_id: 20001,
      messages: [
        {
          type: 'node',
          data: {
            user_id: 20002,
            nickname: '群友',
            content: [{ type: 'text', data: { text: '转发内容' } }],
          },
        },
      ],
    },
    makeContext(backend),
  );

  assert.equal(response.status, 'ok');
  assert.deepEqual(response.data, {
    message_id: 42,
    res_id: 'res-send',
    forward_id: 'res-send',
  });
  assert.equal(calls.send?.[0]?.groupId, 20001);
  assert.deepEqual(calls.send?.[0]?.nodes[0], {
    userId: 20002,
    nickname: '群友',
    message: [{ type: 'text', data: { text: '转发内容' } }],
  });
});

test('send_forward_msg 无目标时只上传；空节点 / 目标冲突走 1400', async () => {
  const calls: {
    upload?: Array<{ groupId?: number; nodes: ForwardNode[] }>;
    send?: Array<{ groupId?: number; nodes: ForwardNode[] }>;
  } = {};
  const backend = makeBackend({ forward: forwardBackend(calls) });
  const registry = new ActionRegistry();
  registerActions(registry, backend);

  const uploadOnly = await registry.call(
    'send_forward_msg',
    {
      messages: [{ type: 'node', data: { content: [{ type: 'text', data: { text: 'hi' } }] } }],
    },
    makeContext(backend),
  );
  assert.deepEqual(uploadOnly.data, {
    message_id: 0,
    res_id: 'res-upload',
    forward_id: 'res-upload',
  });
  assert.equal(calls.upload?.length, 1);

  const empty = await registry.call(
    'send_group_forward_msg',
    { group_id: 20001, messages: [] },
    makeContext(backend),
  );
  assert.equal(empty.retcode, 1400);

  const conflict = await registry.call(
    'send_forward_msg',
    {
      group_id: 20001,
      user_id: 20002,
      messages: [{ type: 'node', data: { content: 'hi' } }],
    },
    makeContext(backend),
  );
  assert.equal(conflict.retcode, 1400);
});

test('get_forward_msg 支持 resId，也支持从 message_id 反查转发段', async () => {
  const calls: { fetched?: string[] } = {};
  const backend = makeBackend({ forward: forwardBackend(calls) });
  const registry = new ActionRegistry();
  registerActions(registry, backend);

  const direct = await registry.call('get_forward_msg', { id: 'res-direct' }, makeContext(backend));
  assert.equal(direct.status, 'ok');
  const data = direct.data as { messages: Array<Record<string, unknown>> };
  assert.equal(data.messages[0]!.message_id, -123);
  assert.equal(data.messages[0]!.message_seq, 66);
  assert.equal(data.messages[0]!.group_id, 20001);
  assert.deepEqual(calls.fetched, ['res-direct']);

  const viaMessageId = await registry.call(
    'get_forward_msg',
    { message_id: '42' },
    makeContext(backend, {
      event: {
        message: [{ type: 'forward', data: { id: 'res-from-event' } }],
      },
    }),
  );
  assert.equal(viaMessageId.status, 'ok');
  assert.deepEqual(calls.fetched, ['res-direct', 'res-from-event']);
});

test('已读上报按消息会话路由；group_id 不匹配走 1400', async () => {
  const marks = { groups: [] as number[], privates: [] as number[] };
  const backend = makeBackend({ readReport: readReportBackend(marks) });
  const registry = new ActionRegistry();
  registerActions(registry, backend);

  await registry.call(
    'mark_group_msg_as_read',
    { message_id: 1, group_id: 20001 },
    makeContext(backend, { meta: { isGroup: true, targetId: 20001, sequence: 3 } }),
  );
  await registry.call(
    'mark_private_msg_as_read',
    { message_id: 2 },
    makeContext(backend, { meta: { isGroup: false, targetId: 20002, sequence: 4 } }),
  );
  await registry.call(
    'mark_msg_as_read',
    { message_id: 3 },
    makeContext(backend, { meta: { isGroup: true, targetId: 20003, sequence: 5 } }),
  );
  assert.deepEqual(marks, { groups: [20001, 20003], privates: [20002] });

  const mismatch = await registry.call(
    'mark_group_msg_as_read',
    { message_id: 1, group_id: 99999 },
    makeContext(backend, { meta: { isGroup: true, targetId: 20001, sequence: 3 } }),
  );
  assert.equal(mismatch.retcode, 1400);
});

test('forward_*_single_msg 用缓存里的消息内容重发', async () => {
  const calls: { forwarded?: Array<{ groupId?: number; userId?: number }> } = {};
  const backend = makeBackend({ forward: forwardBackend(calls) });
  const registry = new ActionRegistry();
  registerActions(registry, backend);

  const response = await registry.call(
    'forward_friend_single_msg',
    { message_id: 7, user_id: 20002 },
    makeContext(backend, {
      event: { message: [{ type: 'text', data: { text: '原消息' } }] },
    }),
  );
  assert.deepEqual(response.data, { message_id: 42 });
  assert.equal(calls.forwarded?.[0]?.userId, 20002);

  const missing = await registry.call(
    'forward_group_single_msg',
    { message_id: 8, group_id: 20001 },
    makeContext(backend),
  );
  assert.equal(missing.retcode, 100);
});

test('send_custom_face 解析收藏表情 URL 并发送图片段', async () => {
  let sent: { groupId?: number; message: unknown[] } | null = null;
  const backend = makeBackend({
    customFace: customFaceBackend(),
    sendGroupMessage: async (groupId, message) => {
      sent = { groupId, message };
      return { sequence: 9 };
    },
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);

  const response = await registry.call(
    'send_custom_face',
    { group_id: 20001, emoji_id: 'u_1_0_0_0_ABC_0_0' },
    makeContext(backend),
  );

  assert.equal(response.status, 'ok');
  assert.equal(sent?.groupId, 20001);
  const segment = sent?.message[0] as { type: string; data: Record<string, unknown> };
  assert.equal(segment.type, 'image');
  assert.equal(segment.data.sub_type, 1);
  assert.equal(segment.data.summary, '[动画表情]');

  const both = await registry.call(
    'send_custom_face',
    { group_id: 20001, user_id: 20002, emoji_id: 'x' },
    makeContext(backend),
  );
  assert.equal(both.retcode, 1400);
});
