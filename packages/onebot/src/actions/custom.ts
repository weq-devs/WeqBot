/**
 * WeqBot 自己的 OneBot 扩展 action：装扮资源 / 字体转换 / 闪照 / 表情弹射 /
 * 泡泡消息 / 群礼物 / 位置共享 / QQ 秀。
 *
 * 这些不是 OneBot v11 标准接口，名字与参数按「一眼能看出做什么」来取。
 * 发送类 action 复用 `sendGroupMessage` / `sendPrivateMessage` 与 `segments.ts`
 * 的新 segment，不额外开一套消息管线。
 */

import {
  ParamError,
  defineAction,
  optionalBool,
  optionalPositiveInt,
  optionalString,
  requiredInt,
  requiredPositiveInt,
  requiredString,
  type ActionContext,
} from '../action-registry';
import type { JsonObject } from '../types';
import type { Segment } from '../segments';

/** 群 / 私聊二选一。 */
type Target = { groupId: number; userId?: undefined } | { groupId?: undefined; userId: number };

function parseTarget(raw: JsonObject): Target {
  const groupId = optionalPositiveInt(raw, 'group_id');
  const userId = optionalPositiveInt(raw, 'user_id');
  if ((groupId === undefined) === (userId === undefined)) {
    throw new ParamError('group_id 与 user_id 必须且只能给一个');
  }
  return groupId !== undefined ? { groupId } : { userId: userId! };
}

function requiredCoord(raw: JsonObject, key: string, limit: number): number {
  const value = raw[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > limit) {
    throw new ParamError(`${key} 必须是 [-${limit}, ${limit}] 内的数字`);
  }
  return value;
}

function optionalNumber(raw: JsonObject, key: string): number | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ParamError(`${key} 必须是数字`);
  }
  return value;
}

function nonNegativeInt(raw: JsonObject, key: string): number {
  const value = requiredInt(raw, key);
  if (value < 0) throw new ParamError(`${key} 不能为负数`);
  return value;
}

/** 发一条消息并给调用方分配 OneBot message_id。 */
async function sendSegments(
  ctx: ActionContext,
  target: Target,
  segments: Segment[],
): Promise<{ message_id: number }> {
  const result =
    target.groupId !== undefined
      ? await ctx.backend.sendGroupMessage(target.groupId, segments)
      : await ctx.backend.sendPrivateMessage(target.userId, segments);

  return {
    message_id: ctx.internSentMessageId({
      isGroup: target.groupId !== undefined,
      targetId: target.groupId ?? target.userId,
      sequence: result.sequence,
      clientSequence: result.clientSequence ?? 0,
      random: result.random ?? 0,
      timestamp: result.timestamp ?? Math.floor(Date.now() / 1000),
    }),
  };
}

const getDressUrl = defineAction(
  {
    name: 'get_dress_url',
    summary: '获取个性装扮（气泡 / 字体 / 头像挂件）的资源下载地址',
    parse: (raw) => {
      const kind = requiredString(raw, 'type') as 'bubble' | 'font' | 'pendant';
      if (kind !== 'bubble' && kind !== 'font' && kind !== 'pendant') {
        throw new ParamError('type 必须是 bubble / font / pendant');
      }
      return { kind, itemId: requiredPositiveInt(raw, 'item_id') };
    },
    run: async ({ kind, itemId }, ctx) => ctx.backend.dress!.getResources({ kind, itemId }),
  },
  { available: (backend) => typeof backend.dress?.getResources === 'function' },
);

const ftf2ttf = defineAction(
  {
    name: 'ftf2ttf',
    summary: '把 FTF 字体转换成 TTF（原生 nt_helper 转换器）',
    parse: (raw) => ({
      input: requiredString(raw, 'file'),
      output: optionalString(raw, 'output'),
      assetsDir: optionalString(raw, 'assets_dir'),
      color: raw.color === undefined ? undefined : optionalBool(raw, 'color'),
      colorChars: optionalString(raw, 'color_chars'),
      checkOts: raw.check_ots === undefined ? undefined : optionalBool(raw, 'check_ots'),
    }),
    run: async (params, ctx) => ctx.backend.font!.convert(params),
  },
  { available: (backend) => typeof backend.font?.convert === 'function' },
);

const sendPrivateFlashPhoto = defineAction({
  name: 'send_private_flash_photo',
  summary: '给好友发一张闪照（阅后即焚，仅私聊）',
  parse: (raw) => ({
    userId: requiredPositiveInt(raw, 'user_id'),
    file: requiredString(raw, 'file'),
  }),
  run: async ({ userId, file }, ctx) =>
    sendSegments(ctx, { userId }, [{ type: 'flash_photo', data: { file } }]),
});

const sendEmojiBounce = defineAction({
  name: 'send_emoji_bounce',
  summary: '表情弹射：让同一个系统表情在聊天窗口里弹射多份',
  parse: (raw) => ({
    target: parseTarget(raw),
    faceId: nonNegativeInt(raw, 'face_id'),
    count: optionalPositiveInt(raw, 'count'),
    name: optionalString(raw, 'name'),
  }),
  run: async ({ target, faceId, count, name }, ctx) =>
    sendSegments(ctx, target, [
      {
        type: 'emoji_bounce',
        data: {
          face_id: faceId,
          ...(count !== undefined ? { count } : {}),
          ...(name !== undefined ? { name } : {}),
        },
      },
    ]),
});

const sendBubbleMsg = defineAction({
  name: 'send_bubble_msg',
  summary: '发送泡泡消息（圆形循环播放的短视频）',
  parse: (raw) => ({
    target: parseTarget(raw),
    file: requiredString(raw, 'file'),
    thumb: optionalString(raw, 'thumb'),
    duration: optionalPositiveInt(raw, 'duration'),
    width: optionalPositiveInt(raw, 'width'),
    height: optionalPositiveInt(raw, 'height'),
    templateName: optionalString(raw, 'template_name'),
  }),
  run: async ({ target, file, thumb, duration, width, height, templateName }, ctx) =>
    sendSegments(ctx, target, [
      {
        type: 'bubble_video',
        data: {
          file,
          ...(thumb !== undefined ? { thumb } : {}),
          ...(duration !== undefined ? { duration } : {}),
          ...(width !== undefined ? { width } : {}),
          ...(height !== undefined ? { height } : {}),
          ...(templateName !== undefined ? { template_name: templateName } : {}),
        },
      },
    ]),
});

const getGroupGiftList = defineAction(
  {
    name: 'get_group_gift_list',
    summary: '获取群礼物面板（页签与礼物列表）',
    parse: (raw) => ({ groupId: requiredPositiveInt(raw, 'group_id') }),
    run: async ({ groupId }, ctx) => ctx.backend.misc!.getGroupGiftList!(groupId),
  },
  { available: (backend) => typeof backend.misc?.getGroupGiftList === 'function' },
);

const sendLocationShare = defineAction(
  {
    name: 'send_location_share',
    summary: '发起位置共享并发送位置共享卡片',
    parse: (raw) => ({
      target: parseTarget(raw),
      longitude: requiredCoord(raw, 'longitude', 180),
      latitude: requiredCoord(raw, 'latitude', 90),
      interval: optionalPositiveInt(raw, 'interval'),
    }),
    run: async ({ target, longitude, latitude, interval }, ctx) => {
      const result = await ctx.backend.location!.start({
        ...target,
        longitude,
        latitude,
        ...(interval !== undefined ? { interval } : {}),
      });
      return {
        code: result.code,
        message: result.message,
        message_id: ctx.internSentMessageId({
          isGroup: target.groupId !== undefined,
          targetId: target.groupId ?? target.userId,
          sequence: result.send.sequence,
          clientSequence: result.send.clientSequence ?? 0,
          random: result.send.random ?? 0,
          timestamp: result.send.timestamp ?? Math.floor(Date.now() / 1000),
        }),
      };
    },
  },
  { available: (backend) => typeof backend.location?.start === 'function' },
);

const updateLocationShare = defineAction(
  {
    name: 'update_location_share',
    summary: '更新位置共享里的当前定位（需按服务端间隔持续调用）',
    parse: (raw) => ({
      target: parseTarget(raw),
      longitude: requiredCoord(raw, 'longitude', 180),
      latitude: requiredCoord(raw, 'latitude', 90),
      extra: optionalNumber(raw, 'extra'),
    }),
    run: async ({ target, longitude, latitude, extra }, ctx) =>
      ctx.backend.location!.report({
        ...target,
        longitude,
        latitude,
        ...(extra !== undefined ? { extra } : {}),
      }),
  },
  { available: (backend) => typeof backend.location?.report === 'function' },
);

const getQqShowUrl = defineAction(
  {
    name: 'get_qq_show_url',
    summary: '获取 QQ 秀图片地址；不传 user_id 时查自己',
    parse: (raw) => ({ userId: optionalPositiveInt(raw, 'user_id') }),
    run: async ({ userId }, ctx) => ctx.backend.profile!.getQqShowUrl!(userId),
  },
  { available: (backend) => typeof backend.profile?.getQqShowUrl === 'function' },
);

export const CUSTOM_ACTIONS = [
  getDressUrl,
  ftf2ttf,
  sendPrivateFlashPhoto,
  sendEmojiBounce,
  sendBubbleMsg,
  getGroupGiftList,
  sendLocationShare,
  updateLocationShare,
  getQqShowUrl,
];
