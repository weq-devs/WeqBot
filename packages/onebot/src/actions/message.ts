/**
 * 消息类 action：发送 / 撤回 / 查询。
 *
 * 搬运自 SnowLuma `packages/onebot/src/actions/message.ts`（2026-11-13），
 * 去掉依赖 `ctx.bridge.apis` 的部分，改成调 {@link OneBotBackend}。
 * **敏感能力（红包 / 转账）不在这里，见 `action-registry.ts` 的 deny-list。**
 */

import {
  defineAction,
  optionalBool,
  optionalPositiveInt,
  optionalString,
  ParamError,
  requiredInt,
  requiredPositiveInt,
  requiredString,
  type ActionContext,
  type ActionDefinition,
  type ActionEntry,
} from '../action-registry';
import { NotImplementedError, type ForwardNode, type ForwardPreview } from '../backend';
import { segmentsToRawMessage } from '../cq';
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
    // 发布包由 build-release.mjs 在打包时把这里替换成 tag 版本；源码 / 测试环境回退占位。
    app_version: process.env.WEQBOT_VERSION ?? '0.0.0',
    protocol_version: 'v11',
  }),
};

// ─────────────────────── 第 1 批：历史 / 合并转发 / 已读 / 收藏表情 ───────────────────────
//
// 参数名 / 返回字段对齐 SnowLuma `actions/extended.ts`（2026-11-15）。
// 与 SnowLuma 的唯一结构性差异：WeqBot 没有消息历史库（硬约束 13），所以
// **不传 `message_id` 时只能用本进程观测到的最后一条消息做锚点**；一条都没见过
// 就明确报错，不返回伪造的空历史。

/** `count` 上限与 SnowLuma 一致（HISTORY_MAX_COUNT）。 */
const HISTORY_MAX_COUNT = 200;
/** 合并转发嵌套深度上限（协议 `FORWARD_MAX_DEPTH`）。 */
const FORWARD_MAX_DEPTH = 8;

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 历史分页价格：SnowLuma 用带符号 int（`message_id` 常为负），0 = 最新。 */
function historyMessageId(raw: JsonObject): number {
  const value = raw.message_id;
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new ParamError('message_id 必须是整数');
  }
  return value;
}

function historyCount(raw: JsonObject): number {
  const value = raw.count;
  if (value === undefined || value === null || value === '') return 20;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ParamError('count 必须是 >= 0 的整数');
  }
  return Math.min(value, HISTORY_MAX_COUNT);
}

/**
 * 解析历史锚点。
 *
 *   - 数字：明确的锚点 seq；
 *   - `'probe'`：没给 message_id 且本进程没见过该会话消息 —— 交给后端用已读探测
 *     取服务端最新序号（不落盘、不猜区间）；
 *   - `'empty'`：锚点不属于该会话 —— 照 SnowLuma 返回空列表，不报错。
 */
function resolveHistoryAnchor(
  ctx: ActionContext,
  params: { isGroup: boolean; targetId: number; messageId: number },
): number | 'probe' | 'empty' {
  if (params.messageId !== 0) {
    const meta = ctx.resolveMessageMeta(params.messageId);
    if (!meta || meta.isGroup !== params.isGroup || meta.targetId !== params.targetId) {
      return 'empty';
    }
    const sequence = params.isGroup ? meta.sequence : (meta.ntSequence ?? 0);
    if (!Number.isInteger(sequence) || sequence <= 0) {
      throw new Error(
        params.isGroup
          ? '该消息缺少群序号，无法作为历史锚点'
          : '该私聊消息缺少服务端序号，无法作为历史锚点',
      );
    }
    return sequence;
  }
  const latest = ctx.findLatestMessageAnchor(params.isGroup, params.targetId);
  return latest ?? 'probe';
}

/** 服务端历史消息 → OneBot 消息事件（含 `message_id` 分配与事件快照缓存）。 */
function historyEvent(
  ctx: ActionContext,
  item: import('../backend').HistoryMessage,
  isGroup: boolean,
  targetId: number,
): Record<string, unknown> {
  const event: Record<string, unknown> = {
    time: item.time,
    self_id: ctx.selfId,
    post_type: item.senderId === ctx.selfId ? 'message_sent' : 'message',
    message_type: isGroup ? 'group' : 'private',
    sub_type: isGroup ? 'normal' : 'friend',
    message_id: 0,
    message_seq: item.sequence,
    user_id: item.senderId,
    message: item.message,
    raw_message: segmentsToRawMessage(item.message as unknown as import('../types').JsonArray),
    font: 0,
    sender: {
      user_id: item.senderId,
      nickname: item.senderName,
      sex: 'unknown',
      age: 0,
    },
    ...(isGroup ? { group_id: targetId } : {}),
  };
  event.message_id = ctx.internMessageEvent(
    {
      isGroup,
      targetId,
      sequence: item.sequence,
      ...(isGroup ? {} : { ntSequence: item.sequence }),
      wireId: item.wireId,
      random: 0,
      timestamp: item.time,
    },
    event,
  );
  return event;
}

/** `messages` / `message` 互为别名。 */
function forwardNodeList(raw: JsonObject): unknown {
  const value = raw.messages ?? raw.message;
  if (value === undefined || value === null) throw new ParamError('message/messages 不能为空');
  return value;
}

/** 节点数组（用于识别嵌套转发）。 */
function isForwardNodeArray(value: unknown): value is unknown[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => {
      if (!isJsonObject(item)) return false;
      if (item.type === 'node') return true;
      return item.type === undefined && (item.content !== undefined || item.message !== undefined);
    })
  );
}

/**
 * OneBot 转发节点 → 后端节点。
 *
 * 接受 `{ type:'node', data:{...} }` 和 SnowLuma 的裸节点兼容形式；`content` 里
 * 再放节点数组时递归成 `children`（协议的嵌套转发）。
 */
function parseForwardNodes(value: unknown, depth = 0): ForwardNode[] {
  if (depth >= FORWARD_MAX_DEPTH) throw new ParamError('转发嵌套层数超限');
  if (!Array.isArray(value) || value.length === 0) {
    throw new ParamError('message/messages 必须是非空的转发节点数组');
  }

  return value.map((item, index) => {
    if (!isJsonObject(item)) throw new ParamError(`messages[${index}] 必须是对象`);
    const type = item.type;
    if (type !== undefined && type !== 'node') {
      throw new ParamError(`messages[${index}].type 必须是 "node"`);
    }
    const rawData = type === 'node' ? item.data : item;
    if (!isJsonObject(rawData)) throw new ParamError(`messages[${index}].data 必须是对象`);
    const data = rawData as JsonObject;

    const userId = optionalPositiveInt(data, 'user_id') ?? optionalPositiveInt(data, 'uin');
    const nickname = optionalString(data, 'nickname') ?? optionalString(data, 'name');
    const nodeTime = optionalPositiveInt(data, 'time');
    const content = data.content ?? data.message;

    if (isForwardNodeArray(content)) {
      return {
        ...(userId !== undefined ? { userId } : {}),
        ...(nickname ? { nickname } : {}),
        ...(nodeTime !== undefined ? { time: nodeTime } : {}),
        message: [],
        children: parseForwardNodes(content, depth + 1),
      };
    }

    const message = parseMessageSegments(content ?? '', false);
    if (message.length === 0) {
      throw new ParamError(
        `messages[${index}] 的 content 不能为空（WeqBot 不支持按节点 message_id 回查）`,
      );
    }
    return {
      ...(userId !== undefined ? { userId } : {}),
      ...(nickname ? { nickname } : {}),
      ...(nodeTime !== undefined ? { time: nodeTime } : {}),
      message,
    };
  });
}

/** NapCat 兼容的预览覆盖项；四项都没有时返回 undefined。 */
function readForwardPreview(raw: JsonObject): ForwardPreview | undefined {
  const source = optionalString(raw, 'source')?.trim();
  const summary = optionalString(raw, 'summary')?.trim();
  const prompt = optionalString(raw, 'prompt')?.trim();
  const news: Array<{ text: string }> = [];
  if (Array.isArray(raw.news)) {
    for (const item of raw.news) {
      if (typeof item === 'string' && item) news.push({ text: item });
      else if (isJsonObject(item) && typeof item.text === 'string' && item.text) {
        news.push({ text: item.text });
      }
    }
  }
  if (!source && !summary && !prompt && news.length === 0) return undefined;
  return {
    ...(source ? { source } : {}),
    ...(summary ? { summary } : {}),
    ...(prompt ? { prompt } : {}),
    ...(news.length > 0 ? { news } : {}),
  };
}

/** 转发目标：群 / 私聊二选一（都为空 = 只上传）。 */
function forwardTarget(raw: JsonObject): { groupId?: number; userId?: number } {
  const groupId = optionalPositiveInt(raw, 'group_id');
  const userId = optionalPositiveInt(raw, 'user_id');
  if (groupId !== undefined && userId !== undefined) {
    throw new ParamError('group_id 与 user_id 只能给一个');
  }
  return {
    ...(groupId !== undefined ? { groupId } : {}),
    ...(userId !== undefined ? { userId } : {}),
  };
}

/** 从消息事件里找合并转发段的 resId。 */
function forwardIdFromEvent(event: Record<string, unknown> | null): string | undefined {
  const segments = Array.isArray(event?.message) ? event.message : [];
  for (const segment of segments) {
    if (!isJsonObject(segment) || segment.type !== 'forward') continue;
    const data = isJsonObject(segment.data) ? segment.data : {};
    const id = data.id ?? data.res_id ?? data.forward_id;
    if (typeof id === 'string' && id.trim()) return id.trim();
  }
  return undefined;
}

/** 消息事件里的内容 → segment 数组（历史快照 / 转发单条用）。 */
function eventSegments(event: Record<string, unknown>): Segment[] {
  const message = event.message;
  if (Array.isArray(message)) return message as Segment[];
  const fallback = (message ?? event.raw_message ?? '') as import('../types').JsonObject;
  return parseMessageSegments(fallback, false);
}

const getGroupMsgHistory = defineAction(
  {
    name: 'get_group_msg_history',
    summary: '获取群消息历史',
    parse: (raw) => ({
      groupId: requiredPositiveInt(raw, 'group_id'),
      messageId: historyMessageId(raw),
      count: historyCount(raw),
      reverseOrder: optionalBool(raw, 'reverse_order', true),
    }),
    run: async ({ groupId, messageId, count, reverseOrder }, ctx) => {
      const anchor = resolveHistoryAnchor(ctx, {
        isGroup: true,
        targetId: groupId,
        messageId,
      });
      if (anchor === 'empty') return { messages: [] };
      const items = await ctx.backend.history!.getGroupHistory({
        groupId,
        ...(typeof anchor === 'number' ? { anchorSequence: anchor } : {}),
        count,
        // 无锚点时 SnowLuma 固定按「锚点及更旧」拉，这里保持一致。
        reverseOrder: messageId === 0 ? true : reverseOrder,
      });
      return { messages: items.map((item) => historyEvent(ctx, item, true, groupId)) };
    },
  },
  { available: (backend) => typeof backend.history?.getGroupHistory === 'function' },
);

const getFriendMsgHistory = defineAction(
  {
    name: 'get_friend_msg_history',
    summary: '获取好友消息历史',
    parse: (raw) => ({
      userId: requiredPositiveInt(raw, 'user_id'),
      messageId: historyMessageId(raw),
      count: historyCount(raw),
      reverseOrder: optionalBool(raw, 'reverse_order', true),
    }),
    run: async ({ userId, messageId, count, reverseOrder }, ctx) => {
      const anchor = resolveHistoryAnchor(ctx, {
        isGroup: false,
        targetId: userId,
        messageId,
      });
      if (anchor === 'empty') return { messages: [] };
      const items = await ctx.backend.history!.getPrivateHistory({
        userId,
        ...(typeof anchor === 'number' ? { anchorSequence: anchor } : {}),
        count,
        reverseOrder: messageId === 0 ? true : reverseOrder,
      });
      return { messages: items.map((item) => historyEvent(ctx, item, false, userId)) };
    },
  },
  { available: (backend) => typeof backend.history?.getPrivateHistory === 'function' },
);

const getForwardMsg = defineAction(
  {
    name: 'get_forward_msg',
    summary: '获取合并转发消息（id 或 message_id）',
    parse: (raw) => ({
      id: optionalString(raw, 'id'),
      messageId: optionalString(raw, 'message_id'),
    }),
    run: async ({ id, messageId }, ctx) => {
      let resId = id?.trim() ?? '';
      if (!resId && messageId !== undefined) {
        const numeric = Number(messageId);
        if (Number.isSafeInteger(numeric) && numeric > 0) {
          resId = forwardIdFromEvent(ctx.resolveMessageEvent(numeric)) ?? '';
        }
        if (!resId) resId = messageId.trim();
      }
      if (!resId) throw new ParamError('id 或 message_id 必须给一个');

      const nodes = await ctx.backend.forward!.getForwardMessage(resId);
      return {
        messages: nodes.map((node) => ({
          self_id: ctx.selfId,
          user_id: node.userId,
          time: node.time,
          message_id: node.messageId,
          message_seq: node.sequence,
          real_id: node.messageId,
          message_type: node.groupId !== undefined ? 'group' : 'private',
          ...(node.groupId !== undefined ? { group_id: node.groupId } : {}),
          sender: { user_id: node.userId, nickname: node.nickname },
          raw_message: segmentsToRawMessage(
            node.message as unknown as import('../types').JsonArray,
          ),
          font: 0,
          sub_type: node.groupId !== undefined ? 'normal' : 'friend',
          message: node.message,
          message_format: 'array',
          post_type: 'message',
        })),
      };
    },
  },
  { available: (backend) => typeof backend.forward?.getForwardMessage === 'function' },
);

const uploadForwardMsg = defineAction(
  {
    name: 'upload_forward_msg',
    summary: '上传转发消息（只上传资源，不发送）',
    parse: (raw) => ({
      nodes: parseForwardNodes(forwardNodeList(raw)),
      groupId: optionalPositiveInt(raw, 'group_id'),
    }),
    run: async ({ nodes, groupId }, ctx) => {
      const { resId } = await ctx.backend.forward!.uploadForward({
        ...(groupId !== undefined ? { groupId } : {}),
        nodes,
      });
      return {
        res_id: resId,
        forward_id: resId,
        message_id: 0,
        ...(groupId !== undefined ? { group_id: groupId } : {}),
      };
    },
  },
  { available: (backend) => typeof backend.forward?.uploadForward === 'function' },
);

/** 发送合并转发：上传 + 发卡片；返回 `{ message_id, res_id, forward_id }`。 */
async function sendForwardTo(
  ctx: ActionContext,
  params: {
    target: { groupId?: number; userId?: number };
    nodes: ForwardNode[];
    preview?: ForwardPreview;
  },
): Promise<{ message_id: number; res_id: string; forward_id: string }> {
  const isGroup = params.target.groupId !== undefined;
  const targetId = params.target.groupId ?? params.target.userId!;
  const result = await ctx.backend.forward!.sendForward({
    ...params.target,
    nodes: params.nodes,
    ...(params.preview ? { preview: params.preview } : {}),
  });
  return {
    ...intern(ctx, {
      isGroup,
      targetId,
      sequence: result.send.sequence,
      clientSequence: result.send.clientSequence,
      random: result.send.random,
      timestamp: result.send.timestamp,
    }),
    res_id: result.resId,
    forward_id: result.resId,
  };
}

const sendForwardMsg = defineAction(
  {
    name: 'send_forward_msg',
    summary: '发送合并转发（按 message_type / group_id / user_id 自动路由）',
    parse: (raw) => {
      const messageType = optionalString(raw, 'message_type');
      const target = forwardTarget(raw);
      const nodes = parseForwardNodes(forwardNodeList(raw));
      if (target.groupId === undefined && target.userId === undefined) {
        if (messageType === 'group') throw new ParamError('群合并转发需要 group_id');
        if (messageType === 'private') throw new ParamError('私聊合并转发需要 user_id');
        return { target, nodes, preview: readForwardPreview(raw), uploadOnly: true };
      }
      if (messageType === 'group' && target.groupId === undefined) {
        throw new ParamError('群合并转发需要 group_id');
      }
      if (messageType === 'private' && target.userId === undefined) {
        throw new ParamError('私聊合并转发需要 user_id');
      }
      return { target, nodes, preview: readForwardPreview(raw), uploadOnly: false };
    },
    run: async ({ target, nodes, preview, uploadOnly }, ctx) => {
      if (uploadOnly) {
        const { resId } = await ctx.backend.forward!.uploadForward({
          ...target,
          nodes,
        });
        return { message_id: 0, res_id: resId, forward_id: resId };
      }
      return sendForwardTo(ctx, {
        target,
        nodes,
        ...(preview ? { preview } : {}),
      });
    },
  },
  {
    available: (backend) =>
      typeof backend.forward?.sendForward === 'function' &&
      typeof backend.forward?.uploadForward === 'function',
  },
);

const sendGroupForwardMsg = defineAction(
  {
    name: 'send_group_forward_msg',
    summary: '发送群合并转发',
    parse: (raw) => ({
      groupId: requiredPositiveInt(raw, 'group_id'),
      nodes: parseForwardNodes(forwardNodeList(raw)),
      preview: readForwardPreview(raw),
    }),
    run: async ({ groupId, nodes, preview }, ctx) =>
      sendForwardTo(ctx, {
        target: { groupId },
        nodes,
        ...(preview ? { preview } : {}),
      }),
  },
  { available: (backend) => typeof backend.forward?.sendForward === 'function' },
);

const sendPrivateForwardMsg = defineAction(
  {
    name: 'send_private_forward_msg',
    summary: '发送私聊合并转发',
    parse: (raw) => ({
      userId: requiredPositiveInt(raw, 'user_id'),
      nodes: parseForwardNodes(forwardNodeList(raw)),
      preview: readForwardPreview(raw),
    }),
    run: async ({ userId, nodes, preview }, ctx) =>
      sendForwardTo(ctx, {
        target: { userId },
        nodes,
        ...(preview ? { preview } : {}),
      }),
  },
  { available: (backend) => typeof backend.forward?.sendForward === 'function' },
);

/** 已读上报共用的锚点解析：未知 / 类型不匹配都按业务失败，不静默成功。 */
function readAnchor(ctx: ActionContext, messageId: number) {
  const meta = ctx.resolveMessageMeta(messageId);
  if (!meta) throw new Error(`未知的 message_id：${messageId}（只认识本进程收到 / 发出的消息）`);
  return meta;
}

const markGroupMsgAsRead = defineAction(
  {
    name: 'mark_group_msg_as_read',
    summary: '标记群消息已读',
    parse: (raw) => ({
      messageId: requiredInt(raw, 'message_id'),
      groupId: optionalPositiveInt(raw, 'group_id'),
    }),
    run: async ({ messageId, groupId }, ctx) => {
      const meta = readAnchor(ctx, messageId);
      if (!meta.isGroup) throw new Error('message_id 不是群消息');
      if (groupId !== undefined && groupId !== meta.targetId) {
        throw new ParamError('group_id 与消息所属群不一致');
      }
      await ctx.backend.readReport!.markGroupRead(meta.targetId);
      return null;
    },
  },
  { available: (backend) => typeof backend.readReport?.markGroupRead === 'function' },
);

const markPrivateMsgAsRead = defineAction(
  {
    name: 'mark_private_msg_as_read',
    summary: '标记私聊消息已读',
    parse: (raw) => ({
      messageId: requiredInt(raw, 'message_id'),
      userId: optionalPositiveInt(raw, 'user_id'),
    }),
    run: async ({ messageId, userId }, ctx) => {
      const meta = readAnchor(ctx, messageId);
      if (meta.isGroup) throw new Error('message_id 不是私聊消息');
      if (userId !== undefined && userId !== meta.targetId) {
        throw new ParamError('user_id 与消息所属会话不一致');
      }
      await ctx.backend.readReport!.markPrivateRead(meta.targetId);
      return null;
    },
  },
  {
    available: (backend) =>
      typeof backend.readReport?.markGroupRead === 'function' &&
      typeof backend.readReport?.markPrivateRead === 'function',
  },
);

const markMsgAsRead = defineAction(
  {
    name: 'mark_msg_as_read',
    summary: '标记消息已读（群聊 / 私聊自动路由）',
    parse: (raw) => ({
      messageId: requiredInt(raw, 'message_id'),
      targetId: optionalPositiveInt(raw, 'target_id'),
    }),
    run: async ({ messageId, targetId }, ctx) => {
      const meta = readAnchor(ctx, messageId);
      if (targetId !== undefined && targetId !== meta.targetId) {
        throw new ParamError('target_id 与消息所属会话不一致');
      }
      if (meta.isGroup) await ctx.backend.readReport!.markGroupRead(meta.targetId);
      else await ctx.backend.readReport!.markPrivateRead(meta.targetId);
      return null;
    },
  },
  {
    available: (backend) =>
      typeof backend.readReport?.markGroupRead === 'function' &&
      typeof backend.readReport?.markPrivateRead === 'function',
  },
);

/** 单条转发共用实现。 */
async function forwardSingle(
  ctx: ActionContext,
  params: { target: { groupId?: number; userId?: number }; messageId: number },
) {
  const event = ctx.resolveMessageEvent(params.messageId);
  if (!event) throw new Error(`未知的 message_id：${params.messageId}`);
  const message = eventSegments(event);
  if (message.length === 0) throw new Error('这条消息没有可转发的内容');
  const isGroup = params.target.groupId !== undefined;
  const targetId = params.target.groupId ?? params.target.userId!;
  const send = await ctx.backend.forward!.forwardSingleMessage({
    ...params.target,
    message,
  });
  return intern(ctx, {
    isGroup,
    targetId,
    sequence: send.sequence,
    clientSequence: send.clientSequence,
    random: send.random,
    timestamp: send.timestamp,
  });
}

const forwardFriendSingleMsg = defineAction(
  {
    name: 'forward_friend_single_msg',
    summary: '转发单条消息给好友',
    parse: (raw) => ({
      messageId: requiredInt(raw, 'message_id'),
      userId: requiredPositiveInt(raw, 'user_id'),
    }),
    run: async ({ messageId, userId }, ctx) =>
      forwardSingle(ctx, { target: { userId }, messageId }),
  },
  { available: (backend) => typeof backend.forward?.forwardSingleMessage === 'function' },
);

const forwardGroupSingleMsg = defineAction(
  {
    name: 'forward_group_single_msg',
    summary: '转发单条消息到群',
    parse: (raw) => ({
      messageId: requiredInt(raw, 'message_id'),
      groupId: requiredPositiveInt(raw, 'group_id'),
    }),
    run: async ({ messageId, groupId }, ctx) =>
      forwardSingle(ctx, { target: { groupId }, messageId }),
  },
  { available: (backend) => typeof backend.forward?.forwardSingleMessage === 'function' },
);

const sendCustomFace = defineAction(
  {
    name: 'send_custom_face',
    summary: '发送账号收藏表情（emoji_id 或 MD5）',
    parse: (raw) => {
      const groupId = optionalPositiveInt(raw, 'group_id');
      const userId = optionalPositiveInt(raw, 'user_id');
      if ((groupId === undefined) === (userId === undefined)) {
        throw new ParamError('group_id 与 user_id 必须且只能给一个');
      }
      return {
        emojiId: requiredString(raw, 'emoji_id'),
        groupId,
        userId,
        replyTo:
          raw.reply_to === undefined || raw.reply_to === null
            ? undefined
            : requiredInt(raw, 'reply_to'),
      };
    },
    run: async ({ emojiId, groupId, userId, replyTo }, ctx) => {
      const face = await ctx.backend.customFace!.resolveCustomFaceUrl(emojiId);
      if (!face.url) throw new Error(`收藏表情没有可用 URL：${face.emojiId}`);
      const segments: Segment[] = [];
      if (replyTo !== undefined) segments.push({ type: 'reply', data: { id: String(replyTo) } });
      segments.push({
        type: 'image',
        data: { file: face.url, url: face.url, sub_type: 1, summary: '[动画表情]' },
      });
      const isGroup = groupId !== undefined;
      const targetId = groupId ?? userId!;
      const result = isGroup
        ? await ctx.backend.sendGroupMessage(groupId!, segments)
        : await ctx.backend.sendPrivateMessage(userId!, segments);
      return intern(ctx, { isGroup, targetId, ...result });
    },
  },
  { available: (backend) => typeof backend.customFace?.resolveCustomFaceUrl === 'function' },
);

/** 消息类 action。每条声明它需要哪些后端方法。 */
/** SnowLuma 的拼写别名（`upload_foward_msg`），与 `upload_forward_msg` 同形。 */
const uploadFowardMsg: ActionEntry = {
  ...uploadForwardMsg,
  definition: {
    ...uploadForwardMsg.definition,
    name: 'upload_foward_msg',
  } as ActionDefinition<never, never>,
};

export const MESSAGE_ACTIONS: ActionEntry[] = [
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
  getGroupMsgHistory,
  getFriendMsgHistory,
  getForwardMsg,
  uploadForwardMsg,
  uploadFowardMsg,
  sendForwardMsg,
  sendGroupForwardMsg,
  sendPrivateForwardMsg,
  markGroupMsgAsRead,
  markPrivateMsgAsRead,
  markMsgAsRead,
  forwardFriendSingleMsg,
  forwardGroupSingleMsg,
  sendCustomFace,
];
