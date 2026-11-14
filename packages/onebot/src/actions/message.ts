/**
 * 消息类 action：发送 / 撤回 / 查询。
 *
 * 搬运自 SnowLuma `packages/onebot/src/actions/message.ts`（2026-11-13），
 * 去掉依赖 `ctx.bridge.apis` 的部分，改成调 {@link OneBotBackend}。
 * **敏感能力（红包 / 转账）不在这里，见 `action-registry.ts` 的 deny-list。**
 */

import {
  optionalBool,
  optionalPositiveInt,
  ParamError,
  requiredPositiveInt,
  type ActionContext,
  type ActionDefinition,
} from '../action-registry';
import { NotImplementedError } from '../backend';
import { parseMessageSegments } from '../message-parser';
import type { Segment } from '../segments';
import type { JsonObject } from '../types';

type Segments = Segment[];
type SendOutcome = { message_id: number };

function messageSegments(raw: JsonObject): Segments {
  const segments = parseMessageSegments(raw.message, optionalBool(raw, 'auto_escape'));
  if (segments.length === 0) throw new ParamError('message 不能为空');
  return segments;
}

/** 发送结果 → OneBot `{ message_id }`。 */
function intern(
  ctx: ActionContext,
  params: {
    isGroup: boolean;
    targetId: number;
    sequence: number;
    clientSequence?: number;
    random?: number;
    timestamp?: number;
  },
): SendOutcome {
  return {
    message_id: ctx.internSentMessageId({
      isGroup: params.isGroup,
      targetId: params.targetId,
      sequence: params.sequence,
      clientSequence: params.clientSequence ?? 0,
      random: params.random ?? 0,
      timestamp: params.timestamp ?? Math.floor(Date.now() / 1000),
    }),
  };
}

interface SendGroupParams {
  groupId: number;
  segments: Segments;
}

export const sendGroupMsg: ActionDefinition<SendGroupParams, SendOutcome> = {
  name: 'send_group_msg',
  summary: '发送群消息',
  parse: (raw) => ({
    groupId: requiredPositiveInt(raw, 'group_id'),
    segments: messageSegments(raw),
  }),
  run: async ({ groupId, segments }, ctx) => {
    const result = await ctx.backend.sendGroupMessage(groupId, segments);
    return intern(ctx, { isGroup: true, targetId: groupId, ...result });
  },
};

interface SendPrivateParams {
  userId: number;
  tempGroupId?: number;
  segments: Segments;
}

export const sendPrivateMsg: ActionDefinition<SendPrivateParams, SendOutcome> = {
  name: 'send_private_msg',
  summary: '发送私聊消息',
  parse: (raw) => {
    const tempGroupId = optionalPositiveInt(raw, 'group_id');
    return {
      userId: requiredPositiveInt(raw, 'user_id'),
      ...(tempGroupId ? { tempGroupId } : {}),
      segments: messageSegments(raw),
    };
  },
  run: async ({ userId, tempGroupId, segments }, ctx) => {
    const result = await ctx.backend.sendPrivateMessage(userId, segments, tempGroupId);
    return intern(ctx, { isGroup: false, targetId: userId, ...result });
  },
};

interface SendMsgParams {
  groupId?: number;
  userId?: number;
  isGroup: boolean;
  segments: Segments;
}

export const sendMsg: ActionDefinition<SendMsgParams, SendOutcome> = {
  name: 'send_msg',
  summary: '发送消息（按 message_type / group_id 自动路由）',
  parse: (raw) => {
    const messageType = raw.message_type;
    if (messageType !== undefined && typeof messageType !== 'string') {
      throw new ParamError('message_type 必须是字符串');
    }
    const groupId = optionalPositiveInt(raw, 'group_id');
    const userId = optionalPositiveInt(raw, 'user_id');
    const isGroup = messageType === 'group' || (messageType !== 'private' && groupId !== undefined);
    if (isGroup && groupId === undefined) throw new ParamError('群消息需要 group_id');
    if (!isGroup && userId === undefined) throw new ParamError('私聊消息需要 user_id');
    return { groupId, userId, isGroup, segments: messageSegments(raw) };
  },
  run: async ({ groupId, userId, isGroup, segments }, ctx) => {
    if (isGroup) {
      const result = await ctx.backend.sendGroupMessage(groupId!, segments);
      return intern(ctx, { isGroup: true, targetId: groupId!, ...result });
    }
    const result = await ctx.backend.sendPrivateMessage(userId!, segments);
    return intern(ctx, { isGroup: false, targetId: userId!, ...result });
  },
};

interface MessageIdParams {
  messageId: number;
}

function parseMessageId(raw: Record<string, unknown>): MessageIdParams {
  const messageId = raw.message_id;
  if (typeof messageId !== 'number' || !Number.isSafeInteger(messageId)) {
    throw new ParamError('message_id 必须是整数');
  }
  return { messageId };
}

export const deleteMsg: ActionDefinition<MessageIdParams, null> = {
  name: 'delete_msg',
  summary: '撤回消息',
  parse: parseMessageId,
  run: async ({ messageId }, ctx) => {
    if (!ctx.backend.recall) throw new NotImplementedError('delete_msg');
    const meta = ctx.resolveMessageMeta(messageId);
    if (!meta) throw new ParamError('message_id 未知或不可撤回，需要先收到该消息');
    await ctx.backend.recall(meta);
    return null;
  },
};

export const getMsg: ActionDefinition<MessageIdParams, Record<string, unknown>> = {
  name: 'get_msg',
  summary: '获取消息',
  parse: parseMessageId,
  run: async ({ messageId }, ctx) => {
    const data = ctx.resolveMessageEvent(messageId);
    if (!data) throw new ParamError('message_id 对应的消息不在缓存里');
    const result: Record<string, unknown> = { ...data };
    delete result.post_type;
    delete result.self_id;
    result.real_id = result.message_id ?? messageId;
    return result;
  },
};

export const canSendImage: ActionDefinition<Record<string, never>, { yes: boolean }> = {
  name: 'can_send_image',
  summary: '是否可发送图片',
  run: async (_params, ctx) => ({
    yes: ctx.backend.canSendImage ? await ctx.backend.canSendImage() : false,
  }),
};

export const canSendRecord: ActionDefinition<Record<string, never>, { yes: boolean }> = {
  name: 'can_send_record',
  summary: '是否可发送语音',
  run: async (_params, ctx) => ({
    yes: ctx.backend.canSendRecord ? await ctx.backend.canSendRecord() : false,
  }),
};

export const getStatus: ActionDefinition<
  Record<string, never>,
  { online: boolean; good: boolean; time: number }
> = {
  name: 'get_status',
  summary: '运行状态',
  run: async (_params, ctx) => {
    // 后端不实现时按「在线但未确认健康」回答：适配器已经在跑，说明会话是 up 的。
    const status = ctx.backend.getStatus
      ? await ctx.backend.getStatus()
      : { online: true, good: false };
    return { ...status, time: Math.max(0, Math.floor((Date.now() - ctx.startedAt) / 1000)) };
  },
};

export const getVersionInfo: ActionDefinition<
  Record<string, never>,
  { app_name: string; app_version: string; protocol_version: string }
> = {
  name: 'get_version_info',
  summary: '实现与协议版本',
  run: async () => ({
    app_name: 'WeqBot',
    app_version: '0.0.0',
    protocol_version: 'v11',
  }),
};

/** 消息类 action。每条声明它需要哪些后端方法。 */
export const MESSAGE_ACTIONS: Array<{
  definition: ActionDefinition<never, never>;
  requires: Array<keyof import('../backend').OneBotBackend>;
}> = [
  { definition: sendGroupMsg as ActionDefinition<never, never>, requires: ['sendGroupMessage'] },
  {
    definition: sendPrivateMsg as ActionDefinition<never, never>,
    requires: ['sendPrivateMessage'],
  },
  {
    definition: sendMsg as ActionDefinition<never, never>,
    requires: ['sendGroupMessage', 'sendPrivateMessage'],
  },
  { definition: deleteMsg as ActionDefinition<never, never>, requires: ['recall'] },
  { definition: getMsg as ActionDefinition<never, never>, requires: [] },
  { definition: canSendImage as ActionDefinition<never, never>, requires: [] },
  { definition: canSendRecord as ActionDefinition<never, never>, requires: [] },
  { definition: getStatus as ActionDefinition<never, never>, requires: [] },
  { definition: getVersionInfo as ActionDefinition<never, never>, requires: [] },
];
