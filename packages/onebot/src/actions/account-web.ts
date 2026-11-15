/**
 * 账号侧 web action（P8.5）：装扮 / 会员 / 特别关心 / 好友互动标记。
 *
 * 这些能力 WeQ 桌面端已在用（`account/web/{self_dress,dress_mall,friend_dress,
 * friend_mutualmark,special_care,vip_info}.ts`），本轮把实现搬进
 * `@weqbot/protocol/web` 并在这里暴露成 OneBot action。SnowLuma 只暴露了
 * `_get_friend_dress`，其余是 WeqBot 的补充面 —— 名字加 `_` 前缀的保持兼容。
 */

import {
  ParamError,
  defineAction,
  optionalBool,
  optionalPositiveInt,
  optionalString,
  requiredPositiveInt,
  requiredString,
} from '../action-registry';
import type { JsonObject } from '../types';

/** 可选「目标 uin」：不给就是自己（与 qzone 其余 action 同一口径）。 */
function optionalTarget(raw: JsonObject): number | undefined {
  const value = raw.target_uin ?? raw.user_id;
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new ParamError('target_uin 必须是正整数');
  }
  return value;
}

/** `string[]` 参数：接受数组，也接受单个字符串。 */
function optionalStringArray(raw: JsonObject, key: string): string[] | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value ? [value] : [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ParamError(`${key} 必须是字符串数组`);
  }
  return value as string[];
}

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

  // ── 礼物商城（2026-11-16 补：执行层来自 WeQ `account/web/gift_mall.ts`）──
  //
  // 命名沿用 `get_dress_mall_rank` 的 `*_mall_*` 风格。`to_uin` 是**收礼人**，
  // 不是「看谁的空间」——不给就是自己（查价 / 查愿望单）。

  defineAction(
    {
      name: 'get_gift_mall_home',
      summary: '礼物商城首页推荐、愿望单与服务端页签',
      parse: (raw) => ({ toUin: optionalTarget(raw) }),
      run: async ({ toUin }, ctx) => ctx.backend.accountWeb!.getGiftMallHome!(toUin),
    },
    { available: (backend) => typeof backend.accountWeb?.getGiftMallHome === 'function' },
  ),

  defineAction(
    {
      name: 'get_gift_mall_list',
      summary: '礼物商城首页礼物列表（tab / 子 tab / 游标分页）',
      parse: (raw) => ({
        toUin: optionalTarget(raw),
        tabName: optionalString(raw, 'tab_name'),
        subTabName: optionalStringArray(raw, 'sub_tab_name'),
        attachInfo: optionalString(raw, 'attach_info'),
        batchNum: optionalPositiveInt(raw, 'batch_num'),
        crowdTab: optionalString(raw, 'crowd_tab'),
      }),
      run: async (params, ctx) => ctx.backend.accountWeb!.getGiftMallList!(params),
    },
    { available: (backend) => typeof backend.accountWeb?.getGiftMallList === 'function' },
  ),

  defineAction(
    {
      name: 'search_gift_mall',
      summary: '按关键词搜索礼物商城',
      parse: (raw) => ({
        keyword: requiredString(raw, 'keyword'),
        toUin: optionalTarget(raw),
        pageNo: optionalPositiveInt(raw, 'page_no') ?? 1,
        pageSize: optionalPositiveInt(raw, 'page_size') ?? 20,
        attachInfo: optionalString(raw, 'attach_info'),
      }),
      run: async (params, ctx) => ctx.backend.accountWeb!.searchGiftMall!(params),
    },
    { available: (backend) => typeof backend.accountWeb?.searchGiftMall === 'function' },
  ),

  defineAction(
    {
      name: 'get_gift_mall_gift',
      summary: '查询单个礼物针对收礼人的详情与资格状态',
      parse: (raw) => ({
        giftId: requiredString(raw, 'gift_id'),
        toUin: optionalTarget(raw),
      }),
      run: async ({ giftId, toUin }, ctx) =>
        ctx.backend.accountWeb!.getGiftMallGift!(giftId, toUin),
    },
    { available: (backend) => typeof backend.accountWeb?.getGiftMallGift === 'function' },
  ),

  defineAction(
    {
      name: 'get_gift_mall_vip',
      summary: '查询礼物商城关联的 VIP / SVIP 权益',
      parse: (raw) => ({ giftId: requiredString(raw, 'gift_id') }),
      run: async ({ giftId }, ctx) => ctx.backend.accountWeb!.getGiftMallVip!(giftId),
    },
    { available: (backend) => typeof backend.accountWeb?.getGiftMallVip === 'function' },
  ),

  defineAction(
    {
      name: 'get_gift_mall_wall',
      summary: '礼物墙（送出 / 收到）；游标与 begin_time 原样回传',
      parse: (raw) => {
        const isSend = raw.is_send === undefined ? true : optionalBool(raw, 'is_send');
        const beginTime = raw.begin_time;
        if (typeof beginTime !== 'number' || !Number.isSafeInteger(beginTime)) {
          throw new ParamError('begin_time 必填（首屏传 0）');
        }
        return {
          isSend,
          beginTime,
          batchInfo: optionalString(raw, 'batch_info') ?? '',
        };
      },
      run: async (params, ctx) => ctx.backend.accountWeb!.getGiftMallWall!(params),
    },
    { available: (backend) => typeof backend.accountWeb?.getGiftMallWall === 'function' },
  ),

  defineAction(
    {
      name: 'get_gift_mall_ai_disc_status',
      summary: '礼物商城关联的 AI 内容披露状态',
      parse: () => ({}),
      run: async (_params, ctx) => ctx.backend.accountWeb!.getGiftMallAiDiscStatus!(),
    },
    { available: (backend) => typeof backend.accountWeb?.getGiftMallAiDiscStatus === 'function' },
  ),

  // ⚠️ 写操作：只**下单**，不付款。返回体是支付参数（payMode / url_params 等），
  // 真正的支付必须在客户端完成。不做重试、不落盘（硬约束 13）。
  defineAction(
    {
      name: 'send_gift',
      summary: '赠送礼物（仅下单，返回支付参数；不会自动付款）',
      parse: (raw) => {
        const giftId = requiredPositiveInt(raw, 'gift_id');
        const giftPrice = optionalPositiveInt(raw, 'gift_price');
        const svipDiscount = optionalPositiveInt(raw, 'svip_discount');
        if (giftPrice === undefined || svipDiscount === undefined) {
          throw new ParamError(
            'gift_price 与 svip_discount 必填 —— 从 get_gift_mall_list / get_gift_mall_gift 拿到的原始值原样传回',
          );
        }
        return {
          gift: { giftId, giftPrice, svipDiscount },
          toUin: requiredPositiveInt(raw, 'to_uin'),
          message: optionalString(raw, 'message'),
          needAnonymous: optionalBool(raw, 'need_anonymous'),
          buyNum: optionalPositiveInt(raw, 'buy_num'),
        };
      },
      run: async (params, ctx) => ctx.backend.accountWeb!.sendGift!(params),
    },
    { available: (backend) => typeof backend.accountWeb?.sendGift === 'function' },
  ),
];
