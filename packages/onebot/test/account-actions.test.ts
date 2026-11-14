/**
 * L1 第 2 批（账号 / 资料 / 群扩展）的注册与分发契约。
 *
 * 覆盖三件事：能力缺失 → 1404；参数校验 → 1400；能力存在 → 字段名与
 * SnowLuma 对齐。全部离线，不碰网络。
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
  meta: {
    isGroup: boolean;
    targetId: number;
    sequence: number;
    random?: number;
  } | null = null,
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
            random: meta.random ?? 0,
            timestamp: 0,
          }
        : null,
    resolveMessageEvent: () => null,
    internMessageEvent: () => 43,
    findLatestMessageAnchor: () => null,
  };
}

test('没有 profile / groupEssence / contactsExtra / misc 能力时对应 action 不注册', async () => {
  const registry = new ActionRegistry();
  const { skipped } = registerActions(registry, makeBackend());
  for (const name of [
    'get_profile_like',
    'set_qq_profile',
    'set_qq_avatar',
    'set_online_status',
    'set_diy_online_status',
    'request_decrypt_key',
    'get_friends_with_category',
    'set_friends_category',
    'set_essence_msg',
    'delete_essence_msg',
    'set_group_remark',
    'get_group_info_ex',
    'get_group_detail_info',
    'share_peer',
    'send_ark_share',
    'send_group_ark_share',
    'send_tuwen_ark',
  ]) {
    assert.ok(skipped.includes(name), `${name} 应被跳过`);
  }
  const response = await registry.call('get_profile_like', {}, makeContext(makeBackend()));
  assert.equal(response.retcode, 1404);
});

test('群精华用消息锚点里的 sequence + random，非群消息报 1400', async () => {
  const calls: Array<{ groupId: number; sequence: number; random: number; enable: boolean }> = [];
  const groupEssence: NonNullable<OneBotBackend['groupEssence']> = {
    getEssence: async () => ({ messages: [], complete: true }),
    setEssence: async (params) => {
      calls.push(params);
    },
  };
  const backend = makeBackend({ groupEssence });
  const registry = new ActionRegistry();
  registerActions(registry, backend);

  const added = await registry.call(
    'set_essence_msg',
    { message_id: 42 },
    makeContext(backend, { isGroup: true, targetId: 20001, sequence: 7, random: 99 }),
  );
  assert.equal(added.status, 'ok');
  const removed = await registry.call(
    'delete_essence_msg',
    { message_id: 42 },
    makeContext(backend, { isGroup: true, targetId: 20001, sequence: 7, random: 99 }),
  );
  assert.equal(removed.status, 'ok');
  assert.deepEqual(calls, [
    { groupId: 20001, sequence: 7, random: 99, enable: true },
    { groupId: 20001, sequence: 7, random: 99, enable: false },
  ]);

  const privateMessage = await registry.call(
    'set_essence_msg',
    { message_id: 42 },
    makeContext(backend, { isGroup: false, targetId: 10001, sequence: 1 }),
  );
  assert.equal(privateMessage.retcode, 1400);
});

test('poke 别名分别走私聊 / 群聊，并透传 target_id', async () => {
  const pokes: Array<{ groupId?: number; userId: number; targetId?: number }> = [];
  const backend = makeBackend({
    sendPoke: async (target) => {
      pokes.push(target);
    },
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);

  assert.equal(
    (await registry.call('friend_poke', { user_id: 10002 }, makeContext(backend))).status,
    'ok',
  );
  assert.equal(
    (await registry.call('friend_poke', { user_id: 10002, target_id: 10003 }, makeContext(backend)))
      .status,
    'ok',
  );
  assert.equal(
    (await registry.call('group_poke', { group_id: 20001, user_id: 10002 }, makeContext(backend)))
      .status,
    'ok',
  );
  assert.deepEqual(pokes, [
    { userId: 10002 },
    { userId: 10002, targetId: 10003 },
    { groupId: 20001, userId: 10002 },
  ]);
});

test('群备注 / 扩展群资料字段名对齐 SnowLuma', async () => {
  let remark: { groupId: number; remark: string } | null = null;
  const backend = makeBackend({
    groupAdminExtra: {
      setGroupRemark: async (groupId, value) => {
        remark = { groupId, remark: value };
      },
      getGroupInfoEx: async (groupId) => ({
        groupId,
        groupName: '群',
        memberCount: 3,
        maxMemberCount: 200,
        groupRemark: '备注',
        createTime: 100,
        level: 0,
        memo: '公告预览',
        description: '简介',
        allShut: true,
      }),
    },
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);

  assert.equal(
    (
      await registry.call(
        'set_group_remark',
        { group_id: 20001, remark: '备注' },
        makeContext(backend),
      )
    ).status,
    'ok',
  );
  assert.deepEqual(remark, { groupId: 20001, remark: '备注' });

  const response = await registry.call(
    'get_group_detail_info',
    { group_id: 20001 },
    makeContext(backend),
  );
  assert.deepEqual(response.data, {
    group_id: 20001,
    group_name: '群',
    group_remark: '备注',
    member_count: 3,
    max_member_count: 200,
    group_create_time: 100,
    group_level: 0,
    group_memo: '公告预览',
    group_description: '简介',
    group_all_shut: -1,
  });
});

test('get_profile_like 输出未点赞 / 收藏明细，默认查自己（user_id=0）', async () => {
  let received: { userId?: number; start: number; count: number } | null = null;
  const backend = makeBackend({
    profile: {
      setProfile: async () => {},
      setAvatar: async () => {},
      getProfileLike: async (params) => {
        received = params;
        return {
          uid: 'u_self',
          time: 123,
          favorite: {
            totalCount: 1,
            lastTime: 10,
            todayCount: 1,
            users: [
              {
                uid: 'u_a',
                uin: 0,
                src: 1,
                latestTime: 10,
                count: 1,
                giftCount: 0,
                customId: 0,
                lastCharged: 0,
                availableCount: 0,
                todayVotedCount: 1,
                nick: 'A',
                gender: 1,
                age: 20,
                isFriend: true,
                isVip: true,
                isSvip: false,
              },
            ],
          },
          vote: {
            totalCount: 2,
            newCount: 1,
            newNearbyCount: 0,
            lastVisitTime: 11,
            users: [],
          },
        };
      },
      setOnlineStatus: async () => {},
      setDiyOnlineStatus: async () => {},
    },
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);

  const response = await registry.call('get_profile_like', {}, makeContext(backend));
  assert.equal(response.status, 'ok');
  assert.deepEqual(received, { userId: 0, start: 0, count: 10 });
  const data = response.data as {
    favoriteInfo: { total_count: number; userInfos: Array<Record<string, unknown>> };
    voteInfo: { last_visit_time: number; userInfos: unknown[] };
  };
  assert.equal(data.favoriteInfo.total_count, 1);
  assert.equal(data.voteInfo.last_visit_time, 11);
  assert.deepEqual(data.favoriteInfo.userInfos[0], {
    uid: 'u_a',
    uin: 0,
    src: 1,
    latestTime: 10,
    count: 1,
    giftCount: 0,
    customId: 0,
    lastCharged: 0,
    bAvailableCnt: 0,
    bTodayVotedCnt: 1,
    nick: 'A',
    gender: 1,
    age: 20,
    isFriend: true,
    isvip: true,
    isSvip: false,
  });
  assert.deepEqual(data.voteInfo.userInfos, []);
});

test('set_qq_profile / 在线状态 / 头像参数映射', async () => {
  const profilePatches: unknown[] = [];
  const statuses: unknown[] = [];
  const diy: unknown[] = [];
  const avatars: unknown[] = [];
  const backend = makeBackend({
    profile: {
      setProfile: async (patch) => {
        profilePatches.push(patch);
      },
      setAvatar: async (source) => {
        avatars.push(source);
      },
      getProfileLike: async () => {
        throw new Error('not used');
      },
      setOnlineStatus: async (params) => {
        statuses.push(params);
      },
      setDiyOnlineStatus: async (params) => {
        diy.push(params);
      },
    },
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);

  await registry.call(
    'set_qq_profile',
    { nickname: '昵称', personal_note: '签名', sex: 2 },
    makeContext(backend),
  );
  await registry.call(
    'set_online_status',
    { status: 11, ext_status: 0, battery_status: 80 },
    makeContext(backend),
  );
  await registry.call(
    'set_diy_online_status',
    { face_id: '14', face_type: 1, wording: '学习中' },
    makeContext(backend),
  );
  await registry.call('set_qq_avatar', { file: 'base64://aGVsbG8=' }, makeContext(backend));

  assert.deepEqual(profilePatches, [{ nickname: '昵称', personalNote: '签名', sex: 2 }]);
  assert.deepEqual(statuses, [{ status: 11, extStatus: 0, batteryStatus: 80 }]);
  assert.deepEqual(diy, [{ faceId: 14, faceType: 1, wording: '学习中' }]);
  assert.deepEqual(avatars, [new Uint8Array(Buffer.from('hello'))]);

  // status=0 是非法值（SnowLuma 的 nonZero 校验）。
  const bad = await registry.call('set_online_status', { status: 0 }, makeContext(backend));
  assert.equal(bad.retcode, 1400);
});

test('好友分组与移动分组：字段名、公开资料与二选一校验', async () => {
  const moves: unknown[] = [];
  const backend = makeBackend({
    contactsExtra: {
      getFriendCategories: async () => [
        {
          categoryId: 1,
          categoryName: '同学',
          memberCount: 1,
          friends: [
            {
              userId: 10002,
              nickname: '小明',
              remark: '同桌',
              categoryId: 1,
              profile: {
                sign: '签名',
                sex: 'male',
                age: 20,
                level: 16,
                vipFlag: true,
                svipFlag: false,
                yearVipFlag: false,
                vipLevel: 3,
                privilegeIcons: {
                  jumpUrl: 'https://vip',
                  open: [{ type: 1, level: 2, isBig: true, iconUrl: 'https://icon' }],
                  closed: [],
                },
              },
            },
          ],
        },
      ],
      setFriendCategory: async (params) => {
        moves.push(params);
      },
      getRecommendArk: async () => '',
      sendTuwenArk: async () => ({
        peerType: 1,
        targetId: 1,
        errorCode: 0,
        errorMessage: '',
      }),
    },
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);

  const response = await registry.call(
    'get_friends_with_category',
    { with_profile: true },
    makeContext(backend),
  );
  assert.deepEqual(response.data, [
    {
      categoryId: 1,
      categoryName: '同学',
      categoryMbCount: 1,
      buddyList: [
        {
          user_id: 10002,
          nickname: '小明',
          remark: '同桌',
          category_id: 1,
          long_nick: '签名',
          sex: 'male',
          age: 20,
          level: 16,
          is_qq_vip: true,
          is_vip: false,
          is_years_vip: false,
          vip_level: 3,
          privilege_icons: {
            jump_url: 'https://vip',
            open: [
              {
                type: 1,
                level: 2,
                is_big: 1,
                icon_url: 'https://icon',
              },
            ],
            closed: [],
          },
        },
      ],
    },
  ]);

  assert.equal(
    (
      await registry.call(
        'set_friends_category',
        { uin: 10002, categoryName: '同学' },
        makeContext(backend),
      )
    ).status,
    'ok',
  );
  assert.deepEqual(moves, [{ userId: 10002, categoryName: '同学' }]);

  const both = await registry.call(
    'set_friends_category',
    { uin: 10002, categoryId: 1, categoryName: '同学' },
    makeContext(backend),
  );
  assert.equal(both.retcode, 1400);
});

test('推荐 Ark / 图文 Ark 路由与返回值', async () => {
  const requested: unknown[] = [];
  const tuwen: unknown[] = [];
  const backend = makeBackend({
    contactsExtra: {
      getFriendCategories: async () => [],
      setFriendCategory: async () => {},
      getRecommendArk: async (params) => {
        requested.push(params);
        return '{"app":"ark"}';
      },
      sendTuwenArk: async (params) => {
        tuwen.push(params);
        return {
          peerType: params.peerType,
          targetId: params.targetId,
          errorCode: 0,
          errorMessage: '',
        };
      },
    },
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);

  const peer = await registry.call(
    'share_peer',
    { user_id: 10002, phone_number: '13800000000' },
    makeContext(backend),
  );
  assert.deepEqual(peer.data, { arkMsg: '{"app":"ark"}' });
  const group = await registry.call(
    'send_group_ark_share',
    { group_id: 20001 },
    makeContext(backend),
  );
  assert.equal(group.data, '{"app":"ark"}');

  const sent = await registry.call(
    'send_tuwen_ark',
    {
      user_id: 10002,
      group_id: 20001,
      title: '标题',
      desc: '描述',
      jump_url: 'https://example.com',
    },
    makeContext(backend),
  );
  assert.equal(sent.status, 'ok');
  assert.deepEqual(requested, [
    { kind: 'qq', contactId: 10002, phoneNumber: '13800000000' },
    { kind: 'group', contactId: 20001 },
  ]);
  assert.deepEqual(tuwen, [
    {
      targetId: 20001,
      peerType: 1,
      title: '标题',
      desc: '描述',
      summary: '[分享]',
      previewUrl:
        'https://tangram-1251316161.file.myqcloud.com/files/20210721/e50a8e37e08f29bf1ffc7466e1950690.png',
      jumpUrl: 'https://example.com',
    },
  ]);

  const missing = await registry.call('share_peer', {}, makeContext(backend));
  assert.equal(missing.retcode, 1400);
});

test('request_decrypt_key 原样返回 db_key', async () => {
  const backend = makeBackend({
    misc: {
      requestDecryptKey: async (dbPath) => `key:${dbPath}`,
    },
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);
  const response = await registry.call(
    'request_decrypt_key',
    { db_path: '/tmp/nt_msg.db' },
    makeContext(backend),
  );
  assert.deepEqual(response.data, { db_key: 'key:/tmp/nt_msg.db' });

  const empty = await registry.call('request_decrypt_key', { db_path: ' ' }, makeContext(backend));
  assert.equal(empty.retcode, 1400);
});
