/**
 * P8 新增 action 的注册 / 分发契约。
 *
 * 重点不是逐个字段，而是三条结构性保证：
 *   1. 分组能力缺失 → 整组 action 不注册（1404），不会「注册了再崩」；
 *   2. 能力存在 → 响应形状符合 SnowLuma 的字段名；
 *   3. 依赖 `message_id` 的 action 会先解析锚点，未知 id 明确报错。
 */

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

function makeContext(
  backend: OneBotBackend,
  meta: { isGroup: boolean; targetId: number; sequence: number } | null = null,
): ActionContext {
  return {
    selfId: 10001,
    backend,
    messageFormat: 'array',
    startedAt: Date.now(),
    internSentMessageId: () => 42,
    resolveMessageMeta: () =>
      meta
        ? {
            isGroup: meta.isGroup,
            targetId: meta.targetId,
            sequence: meta.sequence,
            clientSequence: 0,
            random: 0,
            timestamp: 0,
          }
        : null,
    resolveMessageEvent: () => null,
  };
}

const groupFileStub: NonNullable<OneBotBackend['groupFile']> = {
  listGroupFiles: async (_groupId, directory, startIndex) => ({
    files:
      directory === '/' && startIndex === 0
        ? [
            {
              fileId: 'f1',
              fileName: 'a.zip',
              fileSize: 10,
              busId: 102,
              uploadedTime: 1,
              expireTime: 2,
              modifiedTime: 3,
              downloadedTimes: 4,
              uploaderUin: 10001,
              uploaderName: 'bot',
              parentDirectory: '/',
            },
          ]
        : [],
    folders: [],
    isEnd: startIndex > 0,
  }),
  getGroupFileUrl: async () => 'https://cdn/file',
  getGroupFileCount: async () => ({ fileCount: 1, maxCount: 100, isFull: false }),
  getGroupFileSpace: async () => ({ usedSpace: 10, totalSpace: 100 }),
  deleteGroupFile: async () => {},
  renameGroupFile: async () => {},
  moveGroupFile: async () => {},
  createGroupFolder: async () => 'folder-1',
  deleteGroupFolder: async () => {},
  renameGroupFolder: async () => {},
};

test('没有 groupFile 能力时整组群文件 action 不注册', async () => {
  const registry = new ActionRegistry();
  const { skipped } = registerActions(registry, makeBackend());
  assert.ok(skipped.includes('get_group_root_files'));
  const response = await registry.call(
    'get_group_root_files',
    { group_id: 1 },
    makeContext(makeBackend()),
  );
  assert.equal(response.retcode, 1404);
});

test('有 groupFile 能力时字段名对齐 SnowLuma', async () => {
  const registry = new ActionRegistry();
  registerActions(registry, makeBackend({ groupFile: groupFileStub }));
  const response = await registry.call(
    'get_group_root_files',
    { group_id: 20001 },
    makeContext(makeBackend({ groupFile: groupFileStub })),
  );
  assert.equal(response.status, 'ok');
  const data = response.data as { files: Array<Record<string, unknown>>; folders: unknown[] };
  assert.equal(data.files[0]!.file_id, 'f1');
  assert.equal(data.files[0]!.file_name, 'a.zip');
  assert.equal(data.files[0]!.busid, 102);
  assert.equal(data.files[0]!.upload_time, 1);
  assert.deepEqual(data.folders, []);
});

test('qzone 能力按需注册；profile 形状稳定', async () => {
  const bare = new ActionRegistry();
  const { skipped } = registerActions(bare, makeBackend());
  assert.ok(skipped.includes('get_qzone_profile'));

  const qzone: NonNullable<OneBotBackend['qzone']> = {
    getProfile: async () => ({ name: '空间', description: '说明' }),
    setProfile: async () => {},
    getMsgList: async () => ({ total: 0, list: [] }),
    getFeeds: async () => ({ feeds: [], hasMore: false }),
    setLike: async () => {},
    comment: async () => ({ commentId: 'c1' }),
    publish: async () => ({ tid: 't1', time: 1 }),
    deleteMsg: async () => {},
    getPublicCapabilities: async () => ({ entrances: {} }),
    getPublicFeeds: async () => ({ feeds: [], has_more: false }),
    getPublicFeedDetail: async () => ({}),
    getPublicComments: async () => ({}),
    getPublicReplies: async () => ({}),
  };
  const backend = makeBackend({ qzone });
  const registry = new ActionRegistry();
  registerActions(registry, backend);
  const response = await registry.call('get_qzone_profile', {}, makeContext(backend));
  assert.deepEqual(response.data, { name: '空间', description: '说明' });

  const published = await registry.call(
    'send_qzone_msg',
    { content: 'hello', images: [] },
    makeContext(backend),
  );
  assert.deepEqual(published.data, { tid: 't1', time: 1 });
});

test('群待办 / 表情回应用 message_id 锚点解析群号与 seq', async () => {
  const todo: NonNullable<OneBotBackend['groupTodo']> = {
    setGroupTodo: async () => {},
    completeGroupTodo: async () => {},
    cancelGroupTodo: async () => {},
    getGroupTodoList: async () => [
      {
        sourceId: '9_1',
        sequence: '9',
        random: 1,
        text: 'todo',
        createdAt: 1,
        updatedAt: 2,
        completed: false,
      },
    ],
  };
  let reacted: { groupId: number; sequence: number; code: string; isSet: boolean } | null = null;
  const interactionExtra: NonNullable<OneBotBackend['interactionExtra']> = {
    getEmojiLikes: async () => ({ users: [], cookie: '', isLast: true }),
    setReaction: async (params) => {
      reacted = params;
    },
    sendGroupSign: async () => {},
    listSystemFaces: async () => [],
    getSystemFace: async () => null,
    translateEn2Zh: async (words) => words,
  };
  const backend = makeBackend({ groupTodo: todo, interactionExtra });
  const registry = new ActionRegistry();
  registerActions(registry, backend);

  const list = await registry.call(
    'get_group_todo_list',
    { group_id: 20001 },
    makeContext(backend),
  );
  assert.equal(list.status, 'ok');

  const response = await registry.call(
    'set_msg_emoji_like',
    { message_id: 42, emoji_id: '76' },
    makeContext(backend, { isGroup: true, targetId: 20001, sequence: 7 }),
  );
  assert.equal(response.status, 'ok');
  assert.deepEqual(reacted, { groupId: 20001, sequence: 7, code: '76', isSet: true });

  // 未知锚点 -> 业务失败 100（不是静默成功）。
  const missing = await registry.call(
    'set_msg_emoji_like',
    { message_id: 43, emoji_id: '76' },
    makeContext(backend),
  );
  assert.equal(missing.retcode, 100);
});
