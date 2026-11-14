/**
 * 账号侧 web action（P8.5）：装扮 / 会员 / 特别关心 / 好友互动标记。
 *
 * 这些能力 WeQ 桌面端已在用（`account/web/{self_dress,dress_mall,friend_dress,
 * friend_mutualmark,special_care,vip_info}.ts`），本轮把实现搬进
 * `@weqbot/protocol/web` 并在这里暴露成 OneBot action。SnowLuma 只暴露了
 * `_get_friend_dress`，其余是 WeqBot 的补充面 —— 名字加 `_` 前缀的保持兼容。
 */

import {
  defineAction,
  optionalPositiveInt,
  requiredPositiveInt,
  requiredString,
} from '../action-registry';

export const ACCOUNT_WEB_ACTIONS = [
  defineAction(
    {
      name: '_get_friend_dress',
      summary: '查询好友当前使用的装扮',
      parse: (raw) => ({ userId: requiredPositiveInt(raw, 'user_id') }),
      run: async ({ userId }, ctx) => ctx.backend.accountWeb!.getFriendDress(userId),
    },
    { available: (backend) => typeof backend.accountWeb?.getFriendDress === 'function' },
  ),

  defineAction(
    {
      name: 'get_self_dress',
      summary: '查询本账号当前使用的全部装扮',
      parse: () => ({}),
      run: async (_params, ctx) => ctx.backend.accountWeb!.getSelfDress(),
    },
    { available: (backend) => typeof backend.accountWeb?.getSelfDress === 'function' },
  ),

  defineAction(
    {
      name: 'get_vip_info',
      summary: '查询本账号会员身份（VIP / SVIP / 大会员）',
      parse: () => ({}),
      run: async (_params, ctx) => ctx.backend.accountWeb!.getVipInfo(),
    },
    { available: (backend) => typeof backend.accountWeb?.getVipInfo === 'function' },
  ),

  defineAction(
    {
      name: 'get_special_care',
      summary: '查询特别关心列表',
      parse: () => ({}),
      run: async (_params, ctx) => ctx.backend.accountWeb!.getSpecialCare(),
    },
    { available: (backend) => typeof backend.accountWeb?.getSpecialCare === 'function' },
  ),

  defineAction(
    {
      name: 'get_friend_mutual_mark',
      summary: '查询与好友的互动标识（火花 / 巨轮等）',
      parse: (raw) => ({ userId: requiredPositiveInt(raw, 'user_id') }),
      run: async ({ userId }, ctx) => ctx.backend.accountWeb!.getFriendMutualMark(userId),
    },
    { available: (backend) => typeof backend.accountWeb?.getFriendMutualMark === 'function' },
  ),

  defineAction(
    {
      name: 'get_dress_mall_rank',
      summary: '获取装扮商城排行榜（2 气泡 / 4 挂件 / 5 字体）',
      parse: (raw) => ({
        appId: requiredPositiveInt(raw, 'app_id'),
        pageIndex: optionalPositiveInt(raw, 'page_index') ?? 1,
        pageSize: optionalPositiveInt(raw, 'page_size') ?? 20,
      }),
      run: async ({ appId, pageIndex, pageSize }, ctx) =>
        ctx.backend.accountWeb!.getDressRank(appId, pageIndex, pageSize),
    },
    { available: (backend) => typeof backend.accountWeb?.getDressRank === 'function' },
  ),

  defineAction(
    {
      name: 'search_dress',
      summary: '搜索装扮商城',
      parse: (raw) => ({
        appId: requiredPositiveInt(raw, 'app_id'),
        keyword: requiredString(raw, 'keyword'),
        pageIndex: optionalPositiveInt(raw, 'page_index') ?? 0,
        pageSize: optionalPositiveInt(raw, 'page_size') ?? 40,
      }),
      run: async ({ appId, keyword, pageIndex, pageSize }, ctx) =>
        ctx.backend.accountWeb!.searchDress(appId, keyword, pageIndex, pageSize),
    },
    { available: (backend) => typeof backend.accountWeb?.searchDress === 'function' },
  ),
];
