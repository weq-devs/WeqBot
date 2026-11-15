/**
 * L2 补齐（2026-11-16）：礼物商城 action + 普通说说转发。
 *
 * 只验结构性契约：缺能力不注册、参数归一（`to_uin` 缺省是自己、`gift_price`
 * 必须回传）、写操作真的只调一次、转发把 host/tid 传对。
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

const GIFT_ACTIONS = [
  'get_gift_mall_home',
  'get_gift_mall_list',
  'search_gift_mall',
  'get_gift_mall_gift',
  'get_gift_mall_vip',
  'get_gift_mall_wall',
  'get_gift_mall_ai_disc_status',
  'send_gift',
];

test('礼物商城能力全部缺失时不注册（避免注册了再 1404 混过去）', () => {
  const registry = new ActionRegistry();
  const { skipped } = registerActions(registry, makeBackend());
  for (const name of GIFT_ACTIONS) assert.ok(skipped.includes(name), `${name} 应被跳过`);
  assert.equal(registry.has('send_gift'), false);
});

test('只有 sendGift 时只注册 send_gift，其余仍跳过', () => {
  const backend = makeBackend({
    accountWeb: {
      getSelfDress: async () => ({}),
      getVipInfo: async () => ({}),
      getSpecialCare: async () => [],
      getFriendDress: async () => ({}),
      getFriendMutualMark: async () => ({}),
      getDressRank: async () => [],
      searchDress: async () => ({ items: [], total: 0 }),
      sendGift: async () => ({}),
    },
  });
  const registry = new ActionRegistry();
  const { skipped } = registerActions(registry, backend);
  assert.equal(registry.has('send_gift'), true);
  assert.equal(registry.has('get_gift_mall_home'), false);
  assert.ok(skipped.includes('get_gift_mall_home'));
});

test('to_uin 缺省时由后端兜底为自己；显式传则原样透传', async () => {
  const calls: unknown[] = [];
  const backend = makeBackend({
    accountWeb: {
      getSelfDress: async () => ({}),
      getVipInfo: async () => ({}),
      getSpecialCare: async () => [],
      getFriendDress: async () => ({}),
      getFriendMutualMark: async () => ({}),
      getDressRank: async () => [],
      searchDress: async () => ({ items: [], total: 0 }),
      getGiftMallHome: async (toUin) => {
        calls.push(toUin);
        return { tabList: [] };
      },
      getGiftMallList: async (params) => {
        calls.push(params);
        return { giftList: [], attachInfo: '', isEnd: true };
      },
    },
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);

  await registry.call('get_gift_mall_home', {}, ctx(backend));
  assert.deepEqual(calls[0], undefined);

  await registry.call('get_gift_mall_home', { target_uin: 20002 }, ctx(backend));
  assert.equal(calls[1], 20002);

  await registry.call(
    'get_gift_mall_list',
    { target_uin: 20002, tab_name: '礼品卡', sub_tab_name: ['音乐会员'], batch_num: 10 },
    ctx(backend),
  );
  assert.deepEqual(calls[2], {
    toUin: 20002,
    tabName: '礼品卡',
    subTabName: ['音乐会员'],
    attachInfo: undefined,
    batchNum: 10,
    crowdTab: undefined,
  });
});

test('get_gift_mall_wall 要求 begin_time（首屏传 0），布尔参数可省', async () => {
  const calls: unknown[] = [];
  const backend = makeBackend({
    accountWeb: {
      getSelfDress: async () => ({}),
      getVipInfo: async () => ({}),
      getSpecialCare: async () => [],
      getFriendDress: async () => ({}),
      getFriendMutualMark: async () => ({}),
      getDressRank: async () => [],
      searchDress: async () => ({ items: [], total: 0 }),
      getGiftMallWall: async (params) => {
        calls.push(params);
        return { giftsList: [], isEnd: true, extInfo: '', beginTime: 0 };
      },
    },
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);

  const missing = await registry.call('get_gift_mall_wall', {}, ctx(backend));
  assert.equal(missing.retcode, 1400);

  await registry.call('get_gift_mall_wall', { begin_time: 0 }, ctx(backend));
  assert.deepEqual(calls[0], { isSend: true, beginTime: 0, batchInfo: '' });
});

test('send_gift 缺少 gift_price / svip_discount 时在发请求前被拦下', async () => {
  let called = 0;
  const backend = makeBackend({
    accountWeb: {
      getSelfDress: async () => ({}),
      getVipInfo: async () => ({}),
      getSpecialCare: async () => [],
      getFriendDress: async () => ({}),
      getFriendMutualMark: async () => ({}),
      getDressRank: async () => [],
      searchDress: async () => ({ items: [], total: 0 }),
      sendGift: async () => {
        called += 1;
        return {};
      },
    },
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);

  const missing = await registry.call('send_gift', { gift_id: 100, to_uin: 20002 }, ctx(backend));
  assert.equal(missing.retcode, 1400);
  assert.equal(called, 0);

  const ok = await registry.call(
    'send_gift',
    { gift_id: 100, to_uin: 20002, gift_price: 520, svip_discount: 500, message: '生日快乐' },
    ctx(backend),
  );
  assert.equal(ok.retcode, 0);
  assert.equal(called, 1);
});

test('forward_qzone_msg 把 host 与 tid 传对，reason 缺省为空串', async () => {
  const calls: unknown[] = [];
  const backend = makeBackend({
    qzone: {
      getProfile: async () => ({ name: '', description: '' }),
      setProfile: async () => {},
      getMsgList: async () => ({ total: 0, list: [] }),
      getMsgDetail: async () => ({}),
      getHomeFeeds: async () => ({ feeds: [], has_more: false, next_cursor: null }),
      getFeedDetail: async () => ({ feed: {}, attach_info: null }),
      getShareArk: async () => ({ ark: '', requires_confirmation: false, notice: null }),
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
      forwardMsg: async (targetUin, tid, reason) => {
        calls.push([targetUin, tid, reason]);
      },
    },
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);

  await registry.call('forward_qzone_msg', { tid: 'abc123' }, ctx(backend));
  assert.deepEqual(calls[0], [undefined, 'abc123', '']);

  await registry.call(
    'forward_qzone_msg',
    { target_uin: 30003, tid: 'xyz789', reason: '转一个' },
    ctx(backend),
  );
  assert.deepEqual(calls[1], [30003, 'xyz789', '转一个']);
});
