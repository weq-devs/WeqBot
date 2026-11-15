/**
 * 账号 / 资料 / 好友分组 / 在线状态 action（L1 第 2 批）。
 *
 * 搬运自 SnowLuma `packages/onebot/src/actions/extended.ts`，参数名与返回字段
 * 照抄，只把实现换成 {@link OneBotBackend}。后端没实现的分组能力不注册
 * （调用 1404），不会出现「注册了但一调就崩」。
 */

import {
  defineAction,
  optionalBool,
  requiredInt,
  requiredPositiveInt,
  requiredString,
  ParamError,
} from '../action-registry';
import type { FriendInfo, FriendPrivilege, ProfileLikeUserInfo } from '../backend';
import { decodeInlineMedia, isInlineMediaSource } from '../segments';
import type { JsonObject } from '../types';

/** 非负整数；不接受 `null` / 字符串。 */
function optionalNonNegativeInt(raw: JsonObject, key: string): number | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ParamError(`${key} 必须是 >= 0 的整数`);
  }
  return value;
}

function requiredNonZeroInt(raw: JsonObject, key: string): number {
  const value = requiredInt(raw, key);
  if (value === 0) throw new ParamError(`${key} 不能为 0`);
  return value;
}

/** `face_id` 兼容 NapCat：数字或纯数字字符串。 */
function parseFaceId(raw: JsonObject): number {
  const value = raw.face_id;
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value)
        ? Number(value)
        : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ParamError('face_id 必须是非负整数');
  }
  return parsed;
}

/** SnowLuma `profileLikeUserSchema` 的字段名。 */
function profileLikeUser(user: ProfileLikeUserInfo) {
  return {
    uid: user.uid,
    uin: user.uin,
    src: user.src,
    latestTime: user.latestTime,
    count: user.count,
    giftCount: user.giftCount,
    customId: user.customId,
    lastCharged: user.lastCharged,
    bAvailableCnt: user.availableCount,
    bTodayVotedCnt: user.todayVotedCount,
    nick: user.nick,
    gender: user.gender,
    age: user.age,
    isFriend: user.isFriend,
    isvip: user.isVip,
    isSvip: user.isSvip,
  };
}

function privilegeOut(item: FriendPrivilege) {
  return {
    ...(item.type !== undefined ? { type: item.type } : {}),
    ...(item.level !== undefined ? { level: item.level } : {}),
    ...(item.flag !== undefined ? { flag: item.flag } : {}),
    ...(item.isBig !== undefined ? { is_big: item.isBig ? 1 : 0 } : {}),
    ...(item.jumpUrl ? { jump_url: item.jumpUrl } : {}),
    ...(item.iconUrl ? { icon_url: item.iconUrl } : {}),
    ...(item.deluxeIconUrl ? { deluxe_icon_url: item.deluxeIconUrl } : {}),
  };
}

/** SnowLuma `friendResultSchema`：公开资料按服务端实际返回逐项输出。 */
function friendOut(friend: FriendInfo) {
  const profile = friend.profile ?? {};
  return {
    user_id: friend.userId,
    nickname: friend.nickname,
    remark: friend.remark,
    ...(friend.categoryId !== undefined ? { category_id: friend.categoryId } : {}),
    ...(profile.sign !== undefined ? { long_nick: profile.sign } : {}),
    ...(profile.sex !== undefined ? { sex: profile.sex } : {}),
    ...(profile.age !== undefined ? { age: profile.age } : {}),
    ...(profile.level !== undefined ? { level: profile.level } : {}),
    ...(profile.birthdayYear !== undefined ? { birthday_year: profile.birthdayYear } : {}),
    ...(profile.birthdayMonth !== undefined ? { birthday_month: profile.birthdayMonth } : {}),
    ...(profile.birthdayDay !== undefined ? { birthday_day: profile.birthdayDay } : {}),
    ...(profile.phoneNum !== undefined ? { phone_num: profile.phoneNum } : {}),
    ...(profile.email !== undefined ? { email: profile.email } : {}),
    ...(profile.country !== undefined ? { country: profile.country } : {}),
    ...(profile.province !== undefined ? { province: profile.province } : {}),
    ...(profile.city !== undefined ? { city: profile.city } : {}),
    ...(profile.college !== undefined ? { college: profile.college } : {}),
    ...(profile.vipFlag !== undefined ? { is_qq_vip: profile.vipFlag } : {}),
    ...(profile.svipFlag !== undefined ? { is_vip: profile.svipFlag } : {}),
    ...(profile.yearVipFlag !== undefined ? { is_years_vip: profile.yearVipFlag } : {}),
    ...(profile.vipLevel !== undefined ? { vip_level: profile.vipLevel } : {}),
    ...(profile.privilegeIcons
      ? {
          privilege_icons: {
            ...(profile.privilegeIcons.jumpUrl ? { jump_url: profile.privilegeIcons.jumpUrl } : {}),
            open: profile.privilegeIcons.open.map(privilegeOut),
            closed: profile.privilegeIcons.closed.map(privilegeOut),
          },
        }
      : {}),
  };
}

const getProfileLike = defineAction(
  {
    name: 'get_profile_like',
    summary: '获取资料点赞',
    parse: (raw) => ({
      userId: optionalNonNegativeInt(raw, 'user_id') ?? 0,
      start: optionalNonNegativeInt(raw, 'start') ?? 0,
      count: optionalNonNegativeInt(raw, 'count') ?? 10,
    }),
    run: async ({ userId, start, count }, ctx) => {
      const info = await ctx.backend.profile!.getProfileLike({ userId, start, count });
      return {
        uid: info.uid,
        time: info.time,
        favoriteInfo: {
          total_count: info.favorite.totalCount,
          last_time: info.favorite.lastTime,
          today_count: info.favorite.todayCount,
          userInfos: info.favorite.users.map(profileLikeUser),
        },
        voteInfo: {
          total_count: info.vote.totalCount,
          new_count: info.vote.newCount,
          new_nearby_count: info.vote.newNearbyCount,
          last_visit_time: info.vote.lastVisitTime,
          userInfos: info.vote.users.map(profileLikeUser),
        },
      };
    },
  },
  { available: (backend) => typeof backend.profile?.getProfileLike === 'function' },
);

const setQqProfile = defineAction(
  {
    name: 'set_qq_profile',
    summary: '设置 QQ 资料',
    parse: (raw) => {
      const sex = raw.sex;
      if (sex !== undefined && (typeof sex !== 'number' || ![0, 1, 2].includes(sex))) {
        throw new ParamError('sex 只能是 0 / 1 / 2');
      }
      return {
        nickname: typeof raw.nickname === 'string' ? raw.nickname : undefined,
        personalNote: typeof raw.personal_note === 'string' ? raw.personal_note : undefined,
        sex: sex as 0 | 1 | 2 | undefined,
      };
    },
    run: async (patch, ctx) => {
      await ctx.backend.profile!.setProfile(patch);
      return null;
    },
  },
  { available: (backend) => typeof backend.profile?.setProfile === 'function' },
);

const setQqAvatar = defineAction(
  {
    name: 'set_qq_avatar',
    summary: '设置 QQ 头像',
    parse: (raw) => {
      const file = requiredString(raw, 'file').trim();
      if (!file) throw new ParamError('file 不能为空');
      const inline = isInlineMediaSource(file) ? decodeInlineMedia(file) : undefined;
      if (isInlineMediaSource(file) && !inline) throw new ParamError('file 不是合法的 base64 数据');
      return { file, inline };
    },
    run: async ({ file, inline }, ctx) => {
      await ctx.backend.profile!.setAvatar(inline ?? file);
      return null;
    },
  },
  { available: (backend) => typeof backend.profile?.setAvatar === 'function' },
);

const setOnlineStatus = defineAction(
  {
    name: 'set_online_status',
    summary: '设置在线状态',
    parse: (raw) => ({
      status: requiredNonZeroInt(raw, 'status'),
      extStatus: optionalNonNegativeInt(raw, 'ext_status') ?? 0,
      batteryStatus: optionalNonNegativeInt(raw, 'battery_status') ?? 100,
    }),
    run: async (params, ctx) => {
      await ctx.backend.profile!.setOnlineStatus(params);
      return null;
    },
  },
  { available: (backend) => typeof backend.profile?.setOnlineStatus === 'function' },
);

const setDiyOnlineStatus = defineAction(
  {
    name: 'set_diy_online_status',
    summary: '设置自定义在线状态',
    parse: (raw) => ({
      faceId: parseFaceId(raw),
      faceType: optionalNonNegativeInt(raw, 'face_type') ?? 1,
      wording: typeof raw.wording === 'string' ? raw.wording : '',
    }),
    run: async (params, ctx) => {
      await ctx.backend.profile!.setDiyOnlineStatus(params);
      return null;
    },
  },
  { available: (backend) => typeof backend.profile?.setDiyOnlineStatus === 'function' },
);

const requestDecryptKey = defineAction(
  {
    name: 'request_decrypt_key',
    summary: '请求数据库解密密钥',
    parse: (raw) => {
      const dbPath = requiredString(raw, 'db_path').trim();
      if (!dbPath) throw new ParamError('db_path 不能为空');
      return { dbPath };
    },
    run: async ({ dbPath }, ctx) => ({
      db_key: await ctx.backend.misc!.requestDecryptKey(dbPath),
    }),
  },
  { available: (backend) => typeof backend.misc?.requestDecryptKey === 'function' },
);

const getFriendsWithCategory = defineAction(
  {
    name: 'get_friends_with_category',
    summary: '获取分组好友列表',
    parse: (raw) => ({ withProfile: optionalBool(raw, 'with_profile') }),
    run: async ({ withProfile }, ctx) => {
      const categories = await ctx.backend.contactsExtra!.getFriendCategories(withProfile);
      return categories.map((category) => ({
        categoryId: category.categoryId,
        categoryName: category.categoryName,
        categoryMbCount: category.memberCount,
        buddyList: category.friends.map(friendOut),
      }));
    },
  },
  { available: (backend) => typeof backend.contactsExtra?.getFriendCategories === 'function' },
);

const setFriendsCategory = defineAction(
  {
    name: 'set_friends_category',
    summary: '移动好友到指定分组',
    parse: (raw) => {
      const categoryId = optionalNonNegativeInt(raw, 'categoryId');
      const categoryName = raw.categoryName;
      if (categoryName !== undefined && categoryName !== null && typeof categoryName !== 'string') {
        throw new ParamError('categoryName 必须是字符串');
      }
      const name = typeof categoryName === 'string' ? categoryName : undefined;
      if (name !== undefined && !name) throw new ParamError('categoryName 不能为空');
      if ((categoryId === undefined) === (name === undefined)) {
        throw new ParamError('categoryId 与 categoryName 必须且只能给一个');
      }
      return {
        userId: requiredPositiveInt(raw, 'uin'),
        ...(categoryId !== undefined ? { categoryId } : {}),
        ...(name !== undefined ? { categoryName: name } : {}),
      };
    },
    run: async (params, ctx) => {
      await ctx.backend.contactsExtra!.setFriendCategory(params);
      return null;
    },
  },
  { available: (backend) => typeof backend.contactsExtra?.setFriendCategory === 'function' },
);

const setSelfLongNick = defineAction(
  {
    name: 'set_self_longnick',
    summary: '设置个性签名',
    parse: (raw) => {
      const value = raw.longNick ?? raw.long_nick;
      if (typeof value !== 'string') throw new ParamError('longNick / long_nick 必须是字符串');
      return { longNick: value };
    },
    run: async ({ longNick }, ctx) => {
      await ctx.backend.profile!.setSelfLongNick(longNick);
      return {};
    },
  },
  { available: (backend) => typeof backend.profile?.setSelfLongNick === 'function' },
);

const setInputStatus = defineAction(
  {
    name: 'set_input_status',
    summary: '设置好友会话输入状态',
    parse: (raw) => ({
      userId: requiredPositiveInt(raw, 'user_id'),
      eventType: optionalNonNegativeInt(raw, 'event_type') ?? 0,
    }),
    run: async ({ userId, eventType }, ctx) => {
      await ctx.backend.profile!.setInputStatus(userId, eventType);
      return {};
    },
  },
  { available: (backend) => typeof backend.profile?.setInputStatus === 'function' },
);

export const ACCOUNT_ACTIONS = [
  getProfileLike,
  setQqProfile,
  setQqAvatar,
  setOnlineStatus,
  setDiyOnlineStatus,
  requestDecryptKey,
  getFriendsWithCategory,
  setFriendsCategory,
  setSelfLongNick,
  setInputStatus,
];
