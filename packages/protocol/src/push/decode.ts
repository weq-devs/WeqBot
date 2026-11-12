/**
 * `MsgPush` 解码。
 *
 * 分工：
 *   - native：剥 SSO 头、解密、交出 `(command, body)`；
 *   - 本文件：`PUSH_MSG` 包壳 → 逐条 `PUSH_MSG_BODY` → 语义事件；
 *   - `msg/decode.ts`：元素 + 装扮（bubble/font/widget）的具体解析。
 *
 * 不在这里做的事：消息去重、自身消息过滤、OneBot 映射。那些需要会话上下文
 * 或协议之外的约定，放在 `@weqbot/session` / `@weqbot/onebot`。
 */

import { decode } from '../protobuf';
import { decodeMessageBody, type RawMessageBody } from '../msg/decode';
import {
  MSG_PUSH_ENVELOPE,
  FRIEND_RECALL,
  GROUP_NOTIFY_BODY,
  INPUT_STATUS_NOTIFY,
} from './schemas';
import type {
  PushEvent,
  PushFriendRecallEvent,
  PushGroupRecallEvent,
  PushInputStatusEvent,
  PushMessageEvent,
  PushScene,
  PushSystemEvent,
} from './types';

/** OlPush 的 SSO 命令名。 */
export const MSG_PUSH_CMD = 'trpc.msg.olpush.OlPushService.MsgPush';

/** 客户端消息回执（已发送消息被服务端确认），不在 `MsgPush` 通道上。 */
export const CLIENT_MESSAGE_RECEIPT_CMD = 'trpc.msg.olpush.OlPushService.ClientMessageReceipt';

/** `MsgPush` 顶层：tag 1 可重复，所以先收集全部 body 再分发。 */
export interface DecodedPushEnvelope {
  status: number;
  messages: RawMessageBody[];
}

export interface DecodePushOptions {
  /** 保留每条消息的原始 `PUSH_MSG_BODY` 字节（诊断用，默认关）。 */
  keepRaw?: boolean;
}

/** 只解包壳，不做业务分类。历史 / 合并转发抓到的也是这份结构。 */
export function decodePushEnvelope(body: Uint8Array): DecodedPushEnvelope {
  const envelope = decode(MSG_PUSH_ENVELOPE, body) as {
    status?: number;
    messages?: RawMessageBody[];
  };
  return {
    status: envelope.status ?? 0,
    messages: Array.isArray(envelope.messages) ? envelope.messages : [],
  };
}

/**
 * 把一帧 `MsgPush` 的 body 摊平成事件。
 *
 * 一条帧里可能混着聊天消息和系统推送；顺序保持 wire 上的顺序。
 */
export function decodePushBody(body: Uint8Array, options: DecodePushOptions = {}): PushEvent[] {
  const { messages } = decodePushEnvelope(body);
  const out: PushEvent[] = [];

  for (const raw of messages) {
    const msgType = raw.contentHead?.msgType ?? 0;
    const subType = raw.contentHead?.subType ?? 0;
    const time = raw.contentHead?.timestamp ?? 0;
    const fromUin = raw.responseHead?.fromUin ?? 0;
    const fromUid = raw.responseHead?.fromUid ?? '';
    const toUin = raw.responseHead?.toUin ?? 0;
    const groupUin = raw.responseHead?.grp?.groupUin ?? 0;
    const content = raw.body?.msgContent ?? new Uint8Array(0);

    switch (msgType) {
      case 82:
      case 141:
      case 166:
      case 9:
      case 208:
      case 529:
        out.push(messageEvent(raw, options));
        break;

      case 528: {
        const specific = decode0x210(subType, time, content);
        out.push(
          specific ?? {
            kind: 'system',
            msgType,
            subType,
            time,
            fromUin,
            fromUid,
            toUin,
            groupUin,
            content,
          },
        );
        break;
      }

      case 732: {
        const specific = decode0x2DC(subType, time, groupUin, content);
        out.push(
          specific ?? {
            kind: 'system',
            msgType,
            subType,
            time,
            fromUin,
            fromUid,
            toUin,
            groupUin,
            content,
          },
        );
        break;
      }

      default:
        out.push({
          kind: 'system',
          msgType,
          subType,
          time,
          fromUin,
          fromUid,
          toUin,
          groupUin,
          content,
        } satisfies PushSystemEvent);
    }
  }

  return out;
}

/** 完整一帧：`MsgPush` 走业务解码，其余命令原样交给上层（KickNT 等）。 */
export function decodePushFrame(
  frame: { command: string; body: Uint8Array; seq: number },
  options: DecodePushOptions = {},
): PushEvent[] {
  if (frame.command !== MSG_PUSH_CMD) {
    return [{ kind: 'other', command: frame.command, body: frame.body, seq: frame.seq }];
  }
  return decodePushBody(frame.body, options);
}

/**
 * 历史消息 / 合并转发节点 → 与实时推送同形状的消息事件。
 *
 * `SsoGetGroupMsg`、`SsoGetC2cMsg`、`SsoRecvLongMsg` 的 `msgBody` 都是
 * `PUSH_MSG_BODY`，逐个走同一个解码器，装扮与元素因此不会在「转发」路径上丢。
 */
export function decodeMessageBodies(
  bodies: readonly RawMessageBody[],
  options: DecodePushOptions = {},
): PushMessageEvent[] {
  return bodies.map((raw) => messageEvent(raw, options));
}

function messageEvent(raw: RawMessageBody, options: DecodePushOptions): PushMessageEvent {
  const message = decodeMessageBody(raw);
  const scene: PushScene = raw.responseHead?.grp?.groupUin
    ? 'group'
    : message.head.msgType === 141
      ? 'temp'
      : 'private';
  const bytes = options.keepRaw ? raw.body?.msgContent : undefined;
  return {
    kind: 'message',
    scene,
    message,
    ...(bytes ? { raw: bytes } : {}),
  };
}

function decode0x210(
  subType: number,
  time: number,
  content: Uint8Array,
): PushInputStatusEvent | PushFriendRecallEvent | null {
  if (subType === 277) {
    try {
      const notify = decode(INPUT_STATUS_NOTIFY, content) as {
        fromUid?: string;
        toUid?: string;
        notifyItem?: { eventType?: number; statusText?: string };
      };
      if (!notify.fromUid) return null;
      const eventType = notify.notifyItem?.eventType ?? 1;
      return {
        kind: 'input-status',
        time,
        fromUid: notify.fromUid,
        toUid: notify.toUid ?? '',
        eventType,
        text:
          notify.notifyItem?.statusText ??
          (eventType === 3 ? '对方正在讲话...' : '对方正在输入...'),
      };
    } catch {
      return null;
    }
  }

  if (subType === 138 || subType === 139) {
    try {
      const recall = decode(FRIEND_RECALL, content) as {
        info?: { fromUid?: string; toUid?: string; clientSequence?: number; time?: number };
      };
      if (!recall.info) return null;
      const recalledBySelf = subType === 139;
      return {
        kind: 'friend-recall',
        time: recall.info.time ?? time,
        fromUid: recall.info.fromUid ?? '',
        toUid: recall.info.toUid ?? '',
        clientSequence: recall.info.clientSequence ?? 0,
        recalledBySelf,
      } satisfies PushFriendRecallEvent;
    } catch {
      return null;
    }
  }

  return null;
}

function decode0x2DC(
  subType: number,
  time: number,
  groupUin: number,
  content: Uint8Array,
): PushGroupRecallEvent | null {
  if (subType !== 17) return null;
  const payload = unwrapGroupNotify(content);
  if (!payload) return null;
  try {
    const notify = decode(GROUP_NOTIFY_BODY, payload) as {
      groupUin?: number;
      operatorUid?: string;
      recall?: {
        operatorUid?: string;
        recallMessages?: { sequence?: number; time?: number; authorUid?: string }[];
      };
    };
    const recalled = notify.recall?.recallMessages?.[0];
    if (!recalled) return null;
    return {
      kind: 'group-recall',
      time: recalled.time ?? time,
      groupUin: notify.groupUin ?? groupUin,
      operatorUid: notify.recall?.operatorUid || notify.operatorUid || '',
      authorUid: recalled.authorUid ?? '',
      sequence: recalled.sequence ?? 0,
    };
  } catch {
    return null;
  }
}

/** 0x2dc 的 content 前 7 字节是壳，长度字段可能是 BE 也可能是 LE（照 SnowLuma）。 */
function unwrapGroupNotify(content: Uint8Array): Uint8Array | null {
  if (content.length <= 7) return null;
  const lenBe = (content[5]! << 8) | content[6]!;
  const lenLe = content[5]! | (content[6]! << 8);
  if (7 + lenBe <= content.length) return content.subarray(7, 7 + lenBe);
  if (7 + lenLe <= content.length) return content.subarray(7, 7 + lenLe);
  return content.subarray(7);
}
