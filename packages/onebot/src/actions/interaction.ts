/**
 * 互动与请求处理 action：点赞 / 戳一戳 / 加好友与加群请求。
 *
 * 搬运自 SnowLuma `packages/onebot/src/actions/{friend,group-admin}.ts` 的对应
 * 片段（2026-11-13）。`send_like` 的协议支撑 WeqBot 已有
 * （`oidb/interaction/profile-like.ts`），由后端接上即可。
 */

import {
  defineAction,
  optionalString,
  ParamError,
  requiredPositiveInt,
  requiredString,
  type ActionDefinition,
} from '../action-registry';
import type { OneBotBackend } from '../backend';

type Requires = Array<keyof OneBotBackend>;

function define<P, R>(
  definition: ActionDefinition<P, R>,
  requires: Requires,
): { definition: ActionDefinition<never, never>; requires: Requires } {
  return { definition: definition as ActionDefinition<never, never>, requires };
}

const sendLike = define(
  {
    name: 'send_like',
    summary: '给好友点赞',
    parse: (raw) => ({
      userId: requiredPositiveInt(raw, 'user_id'),
      times: raw.times === undefined ? 1 : requiredPositiveInt(raw, 'times'),
    }),
    run: async ({ userId, times }, ctx) => {
      await ctx.backend.sendLike!(userId, times);
      return null;
    },
  },
  ['sendLike'],
);

const sendPoke = define(
  {
    name: 'send_poke',
    summary: '戳一戳',
    parse: (raw) => {
      const groupId = raw.group_id;
      const userId = requiredPositiveInt(raw, 'user_id');
      if (groupId !== undefined && groupId !== null && groupId !== 0) {
        return { groupId: requiredPositiveInt(raw, 'group_id'), userId };
      }
      return { userId };
    },
    run: async (params: { groupId?: number; userId: number }, ctx) => {
      await ctx.backend.sendPoke!(params);
      return null;
    },
  },
  ['sendPoke'],
);

const friendPoke = define(
  {
    name: 'friend_poke',
    summary: '好友拍一拍',
    parse: (raw) => {
      const targetId = raw.target_id;
      return {
        userId: requiredPositiveInt(raw, 'user_id'),
        targetId:
          targetId === undefined || targetId === null || targetId === 0
            ? undefined
            : requiredPositiveInt(raw, 'target_id'),
      };
    },
    run: async ({ userId, targetId }, ctx) => {
      await ctx.backend.sendPoke!({
        userId,
        ...(targetId !== undefined ? { targetId } : {}),
      });
      return null;
    },
  },
  ['sendPoke'],
);

const groupPoke = define(
  {
    name: 'group_poke',
    summary: '群拍一拍',
    parse: (raw) => ({
      groupId: requiredPositiveInt(raw, 'group_id'),
      userId: requiredPositiveInt(raw, 'user_id'),
    }),
    run: async ({ groupId, userId }, ctx) => {
      await ctx.backend.sendPoke!({ groupId, userId });
      return null;
    },
  },
  ['sendPoke'],
);

const setFriendAddRequest = define(
  {
    name: 'set_friend_add_request',
    summary: '处理加好友请求',
    parse: (raw) => {
      const approve = raw.approve;
      if (typeof approve !== 'boolean' && approve !== 1 && approve !== 'true') {
        throw new ParamError('approve 必须是布尔值');
      }
      return {
        flag: requiredString(raw, 'flag'),
        approve: approve === true || approve === 1 || approve === 'true',
        remark: optionalString(raw, 'remark') ?? '',
      };
    },
    run: async ({ flag, approve, remark }, ctx) => {
      await ctx.backend.setFriendAddRequest!(flag, approve, remark);
      return null;
    },
  },
  ['setFriendAddRequest'],
);

const setGroupAddRequest = define(
  {
    name: 'set_group_add_request',
    summary: '处理加群请求',
    parse: (raw) => {
      const approve = raw.approve;
      if (typeof approve !== 'boolean' && approve !== 1 && approve !== 'true') {
        throw new ParamError('approve 必须是布尔值');
      }
      return {
        flag: requiredString(raw, 'flag'),
        approve: approve === true || approve === 1 || approve === 'true',
        reason: optionalString(raw, 'reason') ?? '',
      };
    },
    run: async ({ flag, approve, reason }, ctx) => {
      await ctx.backend.setGroupAddRequest!(flag, approve, reason);
      return null;
    },
  },
  ['setGroupAddRequest'],
);

const clickInlineKeyboardButton = defineAction(
  {
    name: 'click_inline_keyboard_button',
    summary: '点击机器人消息的内联键盘按钮',
    parse: (raw) => ({
      groupId: requiredPositiveInt(raw, 'group_id'),
      botAppid: requiredPositiveInt(raw, 'bot_appid'),
      msgSeq: requiredPositiveInt(raw, 'msg_seq'),
      buttonId: requiredString(raw, 'button_id'),
      callbackData: optionalString(raw, 'callback_data') ?? '',
    }),
    run: async (params, ctx) => {
      const result = await ctx.backend.interactionExtra!.clickInlineButton(params);
      return {
        ...result,
        status: 0,
        promptType: 0,
        promptIcon: 0,
      };
    },
  },
  {
    available: (backend) => typeof backend.interactionExtra?.clickInlineButton === 'function',
  },
);

export const INTERACTION_ACTIONS = [
  sendLike,
  sendPoke,
  friendPoke,
  groupPoke,
  clickInlineKeyboardButton,
  setFriendAddRequest,
  setGroupAddRequest,
];
