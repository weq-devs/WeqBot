/** AI 声聊（0x929D 目录 / 0x929B 合成）三条 action 的离线契约。 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { ActionRegistry, type ActionContext } from '../src/action-registry';
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

function makeContext(backend: OneBotBackend): ActionContext {
  return {
    selfId: 10001,
    backend,
    messageFormat: 'array',
    startedAt: Date.now(),
    internSentMessageId: () => 777,
    resolveMessageMeta: () => null,
    resolveMessageEvent: () => null,
    internMessageEvent: () => 778,
    findLatestMessageAnchor: () => null,
  };
}

test('没有 aiVoice 能力时三条 action 都不注册', async () => {
  const registry = new ActionRegistry();
  const { skipped } = registerActions(registry, makeBackend());
  for (const name of ['get_ai_characters', 'get_ai_record', 'send_group_ai_record']) {
    assert.ok(skipped.includes(name));
    const response = await registry.call(name, { group_id: 20001 }, makeContext(makeBackend()));
    assert.equal(response.retcode, 1404);
  }
});

test('get_ai_characters 按分类映射 SnowLuma 字段名', async () => {
  let received: { groupId: number; chatType: number } | null = null;
  const backend = makeBackend({
    aiVoice: {
      listCharacters: async (groupId, chatType) => {
        received = { groupId, chatType };
        return [
          {
            category: '推荐',
            characters: [
              {
                characterId: 'lucy-voice-suxinjiejie',
                characterName: '酥心姐姐',
                previewUrl: 'https://res.qpt.qq.com/a.wav',
              },
            ],
          },
        ];
      },
      generate: async () => '',
      send: async () => ({ sequence: 1 }),
    },
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);

  const response = await registry.call(
    'get_ai_characters',
    { group_id: 20001 },
    makeContext(backend),
  );
  assert.equal(response.status, 'ok');
  assert.deepEqual(received, { groupId: 20001, chatType: 1 });
  assert.deepEqual(response.data, [
    {
      type: '推荐',
      characters: [
        {
          character_id: 'lucy-voice-suxinjiejie',
          character_name: '酥心姐姐',
          preview_url: 'https://res.qpt.qq.com/a.wav',
        },
      ],
    },
  ]);
});

test('get_ai_record 返回后端给的 URL 字符串，并透传 chat_type', async () => {
  const calls: unknown[] = [];
  const backend = makeBackend({
    aiVoice: {
      listCharacters: async () => [],
      generate: async (groupId, character, text, chatType) => {
        calls.push({ groupId, character, text, chatType });
        return 'https://cdn.example/voice.amr';
      },
      send: async () => ({ sequence: 1 }),
    },
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);

  const response = await registry.call(
    'get_ai_record',
    { group_id: 20001, character: 'lucy', text: '你好', chat_type: 2 },
    makeContext(backend),
  );
  assert.equal(response.data, 'https://cdn.example/voice.amr');
  assert.deepEqual(calls, [{ groupId: 20001, character: 'lucy', text: '你好', chatType: 2 }]);
});

test('send_group_ai_record 用后端回执分配 message_id', async () => {
  const backend = makeBackend({
    aiVoice: {
      listCharacters: async () => [],
      generate: async () => '',
      send: async () => ({ sequence: 31, timestamp: 123 }),
    },
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);

  const response = await registry.call(
    'send_group_ai_record',
    { group_id: 20001, character: 'lucy', text: '你好' },
    makeContext(backend),
  );
  assert.deepEqual(response.data, { message_id: 777 });

  // 空 character / text 是 1400，不是 100。
  const empty = await registry.call(
    'send_group_ai_record',
    { group_id: 20001, character: ' ', text: '你好' },
    makeContext(backend),
  );
  assert.equal(empty.retcode, 1400);
  const badChatType = await registry.call(
    'get_ai_record',
    { group_id: 20001, character: 'lucy', text: '你好', chat_type: -1 },
    makeContext(backend),
  );
  assert.equal(badChatType.retcode, 1400);
});
