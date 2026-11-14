/**
 * 群侧 web action（公告 / 荣誉 / 打卡 / 精华 / 相册）与账号侧 web action。
 *
 * 只验结构性契约：缺能力不注册、参数归一、写操作把 batch/lloc 传对。
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

function ctx(backend: OneBotBackend): ActionContext {
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

test('没有 groupNotice 能力时公告 action 全部 1404', async () => {
  const registry = new ActionRegistry();
  const skipped = registerActions(registry, makeBackend()).skipped;
  for (const name of ['_get_group_notice', '_send_group_notice', '_del_group_notice']) {
    assert.ok(skipped.includes(name), `${name} 应被跳过`);
  }
  const response = await registry.call('_get_group_notice', { group_id: 1 }, ctx(makeBackend()));
  assert.equal(response.retcode, 1404);
});

test('公告读 / 写 / 删都走 groupNotice，fid 兼容 notice_id', async () => {
  const calls: unknown[] = [];
  const backend = makeBackend({
    groupNotice: {
      getGroupNotice: async (groupId) => [{ notice_id: `${groupId}-1` }],
      sendGroupNotice: async (params) => {
        calls.push(['send', params]);
      },
      deleteGroupNotice: async (groupId, fid) => {
        calls.push(['delete', groupId, fid]);
      },
    },
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);

  const list = await registry.call('_get_group_notice', { group_id: 20001 }, ctx(backend));
  assert.deepEqual(list.data, [{ notice_id: '20001-1' }]);

  const sent = await registry.call(
    '_send_group_notice',
    {
      group_id: 20001,
      content: 'hello',
      pinned: 1,
      send_to_new_members: true,
      tip_window_type: 0,
    },
    ctx(backend),
  );
  assert.equal(sent.status, 'ok');
  assert.deepEqual(calls[0], [
    'send',
    {
      groupId: 20001,
      content: 'hello',
      image: undefined,
      pinned: 1,
      type: undefined,
      sendToNewMembers: true,
      isShowEditCard: undefined,
      tipWindowType: 0,
      confirmRequired: undefined,
    },
  ]);

  await registry.call('_del_group_notice', { group_id: 20001, notice_id: 'abc' }, ctx(backend));
  assert.deepEqual(calls[1], ['delete', 20001, 'abc']);
});

test('相册评论 / 点赞 / 删除传对 batch_id 与 lloc', async () => {
  const calls: unknown[] = [];
  const backend = makeBackend({
    groupAlbum: {
      listAlbums: async () => [],
      uploadImage: async () => ({ session: 's' }),
      uploadVideo: async () => ({}),
      listMedia: async (_groupId, _albumId, attachInfo) => ({
        mediaList: [],
        nextAttachInfo: attachInfo ? '' : 'next',
      }),
      comment: async (params) => {
        calls.push(['comment', params]);
        return { id: 'c1' };
      },
      setLike: async (params) => {
        calls.push(['like', params]);
        return { id: params.lloc ?? null, status: params.like ? 0 : 1 };
      },
      deleteMedia: async (params) => {
        calls.push(['delete', params]);
      },
    },
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);

  const media = await registry.call(
    'get_group_album_media_list',
    { group_id: 20001, album_id: 'a1' },
    ctx(backend),
  );
  assert.deepEqual(media.data, { mediaList: [], nextAttachInfo: 'next' });

  await registry.call(
    'do_group_album_comment',
    { group_id: 20001, album_id: 'a1', lloc: 'L', content: '好看', batch_id: 'B' },
    ctx(backend),
  );
  assert.deepEqual(calls[0], [
    'comment',
    { groupId: 20001, albumId: 'a1', lloc: 'L', content: '好看', batchId: 'B' },
  ]);

  await registry.call(
    'set_group_album_media_like',
    { group_id: 20001, album_id: 'a1', batch_id: 'B', lloc: 'L' },
    ctx(backend),
  );
  assert.deepEqual(calls[1], [
    'like',
    { groupId: 20001, albumId: 'a1', batchId: 'B', lloc: 'L', like: true },
  ]);

  await registry.call(
    'del_group_album_media',
    { group_id: 20001, album_id: 'a1', lloc: 'L' },
    ctx(backend),
  );
  assert.deepEqual(calls[2], ['delete', { groupId: 20001, albumId: 'a1', lloc: 'L' }]);
});

test('群荣誉 all 会带上 group_id；打卡参数归一', async () => {
  const seen: unknown[] = [];
  const backend = makeBackend({
    groupHonor: {
      getGroupHonor: async (groupId, type) => {
        seen.push(['honor', groupId, type]);
        return {
          current_talkative: null,
          talkative_list: [],
          performer_list: [],
          legend_list: [],
          emotion_list: [],
        };
      },
    },
    groupSignin: {
      getSignedList: async (params) => {
        seen.push(['sign', params]);
        return [];
      },
    },
    groupEssence: {
      getEssence: async () => ({ messages: [{ msg_seq: 1 }], complete: true }),
    },
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);

  const honor = await registry.call(
    'get_group_honor_info',
    { group_id: 20001, type: 'all' },
    ctx(backend),
  );
  assert.equal((honor.data as { group_id: number }).group_id, 20001);
  assert.deepEqual(seen[0], ['honor', 20001, 'all']);

  await registry.call(
    'get_group_signed_list',
    { group_id: 20001, day_ymd: '20261114', limit: 50 },
    ctx(backend),
  );
  assert.deepEqual(seen[1], [
    'sign',
    { groupId: 20001, dayYmd: '20261114', offset: undefined, limit: 50 },
  ]);

  const essence = await registry.call('get_essence_msg_list', { group_id: 20001 }, ctx(backend));
  assert.deepEqual(essence.data, [{ msg_seq: 1 }]);
});

test('空友写操作要求 feed 对象；账号侧 action 按能力注册', async () => {
  const backend = makeBackend({
    qzone: {
      getProfile: async () => ({ name: '', description: '' }),
      setProfile: async () => {},
      getMsgList: async () => ({ total: 0, list: [] }),
      getFeeds: async () => ({ feeds: [], hasMore: false }),
      setLike: async () => {},
      comment: async () => ({}),
      reply: async () => ({}),
      setMsgRight: async () => ({ ugc_right: 1 }),
      setBan: async () => {},
      publish: async () => ({}),
      deleteMsg: async () => {},
      getPublicCapabilities: async () => ({}),
      getPublicFeeds: async () => ({}),
      getPublicFeedDetail: async () => ({}),
      getPublicComments: async () => ({}),
      getPublicReplies: async () => ({}),
      setPublicUpvote: async () => ({}),
      setPublicLike: async () => ({}),
      setPublicCommentLike: async () => ({}),
      commentPublic: async () => ({}),
      replyPublic: async () => ({}),
      deletePublicComment: async () => {},
      deletePublicReply: async () => {},
      setPublicFollow: async () => ({}),
      forwardPublicFeed: async () => ({}),
    },
    accountWeb: {
      getSelfDress: async () => ({}),
      getVipInfo: async () => null,
      getSpecialCare: async () => ({ items: [], fansCount: null }),
      getFriendDress: async () => ({}),
      getFriendMutualMark: async () => ({}),
      getDressRank: async () => [],
      searchDress: async () => ({ items: [], total: 0 }),
    },
  });
  const registry = new ActionRegistry();
  const { registered } = registerActions(registry, backend);
  for (const name of [
    'set_qzone_public_like',
    'delete_qzone_public_reply',
    'forward_qzone_public_feed',
    'set_qzone_msg_right',
    'set_qzone_ban',
    '_get_friend_dress',
    'get_vip_info',
  ]) {
    assert.ok(registered.includes(name), `${name} 应注册`);
  }

  const bad = await registry.call('set_qzone_public_like', { enable: true }, ctx(backend));
  assert.equal(bad.retcode, 1400);

  const ban = await registry.call('set_qzone_ban', { user_id: 10002 }, ctx(backend));
  assert.equal(ban.status, 'ok');
});
