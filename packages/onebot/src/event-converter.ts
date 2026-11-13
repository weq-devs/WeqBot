/**
 * `BotEvent` → OneBot v11 post。
 *
 * 结构来自 SnowLuma `packages/onebot/src/event-converter/`（2026-11-13）：
 * 统一的 envelope 构造器 + 每种事件一个 converter。WeqBot 的 `BotEvent` 比
 * SnowLuma 的 `QQEventVariant` 更粗（notice 用 `kind` 判别，没有细分到
 * group_mute / group_admin 这类），所以这里按 `kind` 做一次映射，**缺的
 * 通知类型先不编造**，等协议侧补了推送解码再加。
 */

import type { BotEvent, InboundMessage, NoticeEvent, PeerRef } from '@weqbot/session';
import { elementsToSegments } from './segments';
import { segmentsToRawMessage } from './cq';
import type { JsonObject, MessageFormat } from './types';

export interface ConverterContext {
  selfId: number;
  /** 该连接的事件格式；`array` 直接给 segment 数组，`string` 给 CQ 串。 */
  messageFormat: MessageFormat;
  reportSelfMessage: boolean;
  /** `message_id` 分配（`MessageIdMap.intern`）。 */
  internMessageId(message: InboundMessage): number;
  /** 入站图片的下载 URL（可选；没有就留空串）。 */
  imageUrlResolver?: (element: Record<string, unknown>) => Promise<string> | string;
  mediaUrlResolver?: (element: Record<string, unknown>) => Promise<string> | string;
}

function uidToUin(context: ConverterContext, peer: PeerRef): number {
  const asNumber = Number(peer.id);
  if (Number.isSafeInteger(asNumber) && asNumber > 0) return asNumber;
  // peer.id 可能是 uid（输入状态这类推送只带 uid）；查不到就退化成 0。
  return context.selfId;
}

/** notice 的统一信封。 */
function notice(selfId: number, at: number, fields: JsonObject): JsonObject {
  return { time: Math.floor(at / 1000), self_id: selfId, post_type: 'notice', ...fields };
}

/** request 的统一信封。 */
function request(selfId: number, at: number, fields: JsonObject): JsonObject {
  return { time: Math.floor(at / 1000), self_id: selfId, post_type: 'request', ...fields };
}

/** meta_event 的统一信封。 */
export function lifecycleMetaEvent(selfId: number, subType: 'connect' | 'enable' | 'disable') {
  return {
    time: Math.floor(Date.now() / 1000),
    self_id: selfId,
    post_type: 'meta_event',
    meta_event_type: 'lifecycle',
    sub_type: subType,
  } satisfies JsonObject;
}

export function heartbeatMetaEvent(selfId: number, intervalMs: number) {
  return {
    time: Math.floor(Date.now() / 1000),
    self_id: selfId,
    post_type: 'meta_event',
    meta_event_type: 'heartbeat',
    status: { online: true, good: true },
    interval: intervalMs,
  } satisfies JsonObject;
}

/** 消息事件：`message` / `message_sent`。 */
export async function convertMessage(
  context: ConverterContext,
  message: InboundMessage,
): Promise<JsonObject> {
  const isGroup = message.scene === 'group';
  const isSelf = message.sender.id === String(context.selfId);
  const messageId = context.internMessageId(message);

  const segments = await elementsToSegments(
    message.elements as unknown as import('./segments').InboundElement[],
    {
      isGroup,
      selfId: context.selfId,
      ...(context.imageUrlResolver ? { imageUrlResolver: context.imageUrlResolver } : {}),
      ...(context.mediaUrlResolver ? { mediaUrlResolver: context.mediaUrlResolver } : {}),
    },
  );

  const sender: JsonObject = {
    user_id: uidToUin(context, message.sender),
    nickname: message.sender.name ?? '',
    sex: 'unknown',
    age: 0,
  };
  if (message.scene === 'temp') sender.group_id = uidToUin(context, message.peer);

  const fields: JsonObject = {
    message_type: isGroup ? 'group' : 'private',
    sub_type: message.scene === 'group' ? 'normal' : message.scene === 'temp' ? 'group' : 'friend',
    message_id: messageId,
    message_seq: message.seq,
    user_id: uidToUin(context, message.sender),
    message: context.messageFormat === 'string' ? segmentsToRawMessage(segments) : segments,
    raw_message: segmentsToRawMessage(segments),
    font: 0,
    sender,
    ...(isGroup ? { group_id: uidToUin(context, message.peer) } : {}),
    ...(message.dress
      ? {
          dress: {
            bubble: message.dress.bubble,
            font: message.dress.font,
            widget: message.dress.widget,
          },
        }
      : {}),
  };

  return {
    time: message.time,
    self_id: context.selfId,
    post_type: isSelf ? 'message_sent' : 'message',
    ...fields,
  };
}

/**
 * notice 事件。
 *
 * 只映射 WeqBot 已经有的 kind；没建模的返回 `null`，由调用方决定是否记日志。
 */
export async function convertNotice(
  context: ConverterContext,
  event: NoticeEvent,
): Promise<JsonObject | null> {
  const selfId = context.selfId;

  switch (event.kind) {
    case 'message-recall': {
      const isGroup = event.peer.uid === undefined || event.sender !== undefined;
      return notice(selfId, event.at, {
        notice_type: isGroup ? 'group_recall' : 'friend_recall',
        ...(isGroup
          ? { group_id: uidToUin(context, event.peer) }
          : { user_id: uidToUin(context, event.peer) }),
        ...(event.sender ? { user_id: uidToUin(context, event.sender) } : {}),
        ...(event.operator ? { operator_id: uidToUin(context, event.operator) } : {}),
        message_id: Number(event.messageId) || 0,
      });
    }
    case 'input-status':
      return notice(selfId, event.at, {
        notice_type: 'notify',
        sub_type: 'input_status',
        user_id: uidToUin(context, event.peer),
        event_type: event.eventType,
        status_text: event.text,
      });
    case 'poke':
      return notice(selfId, event.at, {
        notice_type: 'notify',
        sub_type: 'poke',
        user_id: uidToUin(context, event.peer),
        sender_id: uidToUin(context, event.sender),
        ...(event.target ? { target_id: uidToUin(context, event.target) } : {}),
      });
    case 'friend-add':
      return notice(selfId, event.at, {
        notice_type: 'friend_add',
        user_id: uidToUin(context, event.friend),
      });
    case 'group-member-increase':
    case 'group-member-decrease':
      return notice(selfId, event.at, {
        notice_type: event.kind === 'group-member-increase' ? 'group_increase' : 'group_decrease',
        sub_type: 'approve',
        group_id: uidToUin(context, event.group),
        user_id: uidToUin(context, event.member),
        ...(event.operator ? { operator_id: uidToUin(context, event.operator) } : {}),
      });
    case 'group-admin':
      return notice(selfId, event.at, {
        notice_type: 'group_admin',
        sub_type: 'set',
        group_id: uidToUin(context, event.group),
        ...(event.member ? { user_id: uidToUin(context, event.member) } : {}),
      });
    case 'group-card':
      return notice(selfId, event.at, {
        notice_type: 'group_card',
        group_id: uidToUin(context, event.group),
        ...(event.member ? { user_id: uidToUin(context, event.member) } : {}),
        card_new: event.detail ?? '',
        card_old: '',
      });
    case 'group-name':
      return notice(selfId, event.at, {
        notice_type: 'notify',
        sub_type: 'group_name',
        group_id: uidToUin(context, event.group),
        name_new: event.detail ?? '',
      });
    case 'other':
      return null;
    default:
      return null;
  }
}

/** request 事件。 */
export function convertRequest(
  context: ConverterContext,
  event: Extract<BotEvent, { type: 'request' }>,
): JsonObject {
  if (event.kind === 'friend') {
    return request(context.selfId, event.at, {
      request_type: 'friend',
      user_id: uidToUin(context, event.from),
      comment: event.comment ?? '',
      flag: event.flag,
    });
  }
  return request(context.selfId, event.at, {
    request_type: 'group',
    sub_type: event.invite ? 'invite' : 'add',
    group_id: uidToUin(context, event.group),
    user_id: uidToUin(context, event.from),
    comment: event.comment ?? '',
    flag: event.flag,
  });
}

/** 统一入口：把一个 `BotEvent` 转成 OneBot post（不能映射的返回 null）。 */
export async function convertEvent(
  context: ConverterContext,
  event: BotEvent,
): Promise<JsonObject | null> {
  switch (event.type) {
    case 'message':
      return convertMessage(context, event.message);
    case 'notice':
      return convertNotice(context, event);
    case 'request':
      return convertRequest(context, event);
    default:
      // state / online / offline / heartbeat / error 走 meta_event 或不下发。
      return null;
  }
}
