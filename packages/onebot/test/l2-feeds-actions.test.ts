/** 空间主页动态 / 详情 / 分享卡片 + 群文件转存。 */

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
    internSentMessageId: () => 42,
    resolveMessageMeta: () => null,
    resolveMessageEvent: () => null,
    internMessageEvent: () => 43,
    findLatestMessageAnchor: () => null,
  };
}

const qzoneStub = {
  getProfile: async () => ({ name: '', description: '' }),
  setProfile: async () => {},
  getMsgList: async () => ({ total: 0, list: [] }),
  getMsgDetail: async () => ({}),
  getHomeFeeds: async () => ({ feeds: [], has_more: false, next_cursor: null }),
  getFeedDetail: async () => ({ feed: {}, attach_info: null }),
  getShareArk: async () => ({ ark: '', requires_confirmation: false, notice: null }),
  getFeeds: async () => ({ feeds: [], hasMore: false }),
  setLike: async () => {},
  comment: async () => ({ commentId: '' }),
  reply: async () => ({ commentId: '' }),
  setMsgRight: async () => ({}) as never,
  setBan: async () => {},
  publish: async () => ({ tid: '', time: 0 }),
  deleteMsg: async () => {},
  getPublicCapabilities: async () => ({}),
  getPublicFeeds: async () => ({ feeds: [], has_more: false, next_cursor: null }),
  getPublicFeedDetail: async () => ({}),
  getPublicComments: async () => ({}),
  getPublicReplies: async () => ({}),
  setPublicUpvote: async () => ({}),
  setPublicLike: async () => ({}),
  setPublicCommentLike: async () => ({}),
  commentPublic: async () => ({}),
  replyPublic: async () => ({}),
  deletePublicComment: async () => ({}),
  deletePublicReply: async () => ({}),
  setPublicFollow: async () => ({}),
  forwardPublicFeed: async () => ({}),
} as unknown as NonNullable<OneBotBackend['qzone']>;

test('没有 qzone 能力时空间动态 action 不注册', async () => {
  const registry = new ActionRegistry();
  const { skipped } = registerActions(registry, makeBackend());
  for (const name of ['get_qzone_home_feeds', 'get_qzone_feed_detail', 'get_qzone_share_ark']) {
    assert.ok(skipped.includes(name), name);
  }
});

test('空间主页 / 详情 / 分享卡片参数与返回透传', async () => {
  const calls: unknown[] = [];
  const backend = makeBackend({
    qzone: {
      ...qzoneStub,
      getHomeFeeds: async (targetUin, cursor) => {
        calls.push({ targetUin, cursor });
        return { feeds: [{ cell_common: {} }], has_more: true, next_cursor: 'next' };
      },
      getFeedDetail: async (tid) => {
        calls.push({ tid });
        return { feed: { cell_common: {} }, attach_info: 'a' };
      },
      getShareArk: async (feed) => {
        calls.push({ feed });
        return { ark: '{}', requires_confirmation: true, notice: '注意' };
      },
    },
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);

  const home = await registry.call(
    'get_qzone_home_feeds',
    { target_uin: 10002, cursor: 'c1' },
    makeContext(backend),
  );
  assert.deepEqual(home.data, {
    feeds: [{ cell_common: {} }],
    has_more: true,
    next_cursor: 'next',
  });

  const detail = await registry.call(
    'get_qzone_feed_detail',
    { tid: '1127000000f1536501000000' },
    makeContext(backend),
  );
  assert.deepEqual(detail.data, { feed: { cell_common: {} }, attach_info: 'a' });

  const ark = await registry.call(
    'get_qzone_share_ark',
    { feed: { cell_common: {} } },
    makeContext(backend),
  );
  assert.deepEqual(ark.data, { ark: '{}', requires_confirmation: true, notice: '注意' });

  assert.deepEqual(calls, [
    { targetUin: 10002, cursor: 'c1' },
    { tid: '1127000000f1536501000000' },
    { feed: { cell_common: {} } },
  ]);

  const missing = await registry.call('get_qzone_share_ark', {}, makeContext(backend));
  assert.equal(missing.retcode, 1400);
});

test('trans_group_file 透传 group_id / file_id 并返回 ok', async () => {
  const calls: unknown[] = [];
  const backend = makeBackend({
    groupFile: {
      uploadGroupFile: async () => ({ fileId: '', fileName: '', fileSize: 0 }),
      uploadPrivateFile: async () => ({ fileId: '' }),
      transGroupFile: async (groupId, fileId) => {
        calls.push({ groupId, fileId });
      },
      listGroupFiles: async () => ({ files: [], folders: [], total: 0 }),
      getGroupFileUrl: async () => '',
      getPrivateFileUrl: async () => '',
      getGroupFileCount: async () => ({ fileCount: 0, maxCount: 0, isFull: false }),
      getGroupFileSpace: async () => ({ usedSpace: 0, totalSpace: 0 }),
      deleteGroupFile: async () => {},
      renameGroupFile: async () => {},
      moveGroupFile: async () => {},
      createGroupFolder: async () => '',
      deleteGroupFolder: async () => {},
      renameGroupFolder: async () => {},
    },
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);
  const response = await registry.call(
    'trans_group_file',
    { group_id: 20001, file_id: 'f1' },
    makeContext(backend),
  );
  assert.deepEqual(response.data, { ok: true });
  assert.deepEqual(calls, [{ groupId: 20001, fileId: 'f1' }]);
});
