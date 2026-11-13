/**
 * `MsgPush` 解码。
 *
 * 分工：
 *   - native：剥 SSO 头、解密、交出 `(command, body)`；
 *   - 本文件：`PUSH_MSG` 包壳 → 逐条 `PUSH_MSG_BODY` → 语义事件；
 *   - `msg/decode.ts`：元素 + 装扮（bubble/font/widget）的具体解析；
 *   - `push/registry.ts`：按 `msgType` 分派系统通知。
 *
 * 不在这里做的事：uin ↔ uid 映射、消息去重（跨帧状态）、自身消息过滤、
 * OneBot 映射。前两者由 `@weqbot/session` 承担（`IdentityCache` / `SysMsgDedup`）。
 */

import { decode } from '../protobuf';
import { decodeMessageBody, type RawMessageBody } from '../msg/decode';
import type { SysMsgDedup } from './dedup';
import { createMsgPushRegistry, type MsgPushRegistry } from './registry';
import { MSG_PUSH_ENVELOPE, SEND_MESSAGE_RESPONSE } from './schemas';
import type {
  PushClientReceiptEvent,
  PushEvent,
  PushMessageEvent,
  PushScene,
} from './types';

/** OlPush 的 SSO 命令名。 */
export const MSG_PUSH_CMD = 'trpc.msg.olpush.OlPushService.MsgPush';

/** 客户端消息回执（本机发出的私聊消息被服务端确认），不在 `MsgPush` 通道上。 */
export const CLIENT_MESSAGE_RECEIPT_CMD = 'trpc.msg.olpush.OlPushService.ClientMessageReceipt';

/** 群/私聊聊天消息的 `msgType`（含历史漫游、文件、转发）。 */
const MESSAGE_TYPES = new Set([82, 141, 166, 9, 208, 529]);

/**
 * QQ NT 把这几类 C2C push 当控制信号走 `OnRecvSysMsg`，不进聊天列表。
 * 照 SnowLuma 的 `blank-filter`：`(msgType, c2cCmd)` 同时命中才丢。
 */
const C2C_CONTROL_TYPES = new Set([141, 166, 167]);
const C2C_CONTROL_CMDS = new Set([1, 73, 75, 129, 131, 133, 135, 192]);

const DEFAULT_REGISTRY = createMsgPushRegistry();

/** `MsgPush` 顶层：tag 1 可重复，所以先收集全部 body 再分发。 */
export interface DecodedPushEnvelope {
  status: number;
  messages: RawMessageBody[];
}

export interface DecodePushOptions {
  /** 保留每条消息的原始 `PUSH_MSG_BODY` 字节（诊断用，默认关）。 */
  keepRaw?: boolean;
  /** 自定义分派表（测试 / 协议扩展用）。 */
  registry?: MsgPushRegistry;
  /** 跨帧系统消息去重；不传则不去重。 */
  dedup?: SysMsgDedup;
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
  const registry = options.registry ?? DEFAULT_REGISTRY;

  for (const raw of messages) {
    const msgType = raw.contentHead?.msgType ?? 0;
    const subType = raw.contentHead?.subType ?? 0;
    const c2cCmd = raw.contentHead?.c2cCmd ?? 0;
    const time = raw.contentHead?.timestamp ?? 0;
    const fromUin = raw.responseHead?.fromUin ?? 0;
    const fromUid = raw.responseHead?.fromUid ?? '';
    const toUin = raw.responseHead?.toUin ?? 0;
    const groupUin = raw.responseHead?.grp?.groupUin ?? 0;
    const content = raw.body?.msgContent ?? new Uint8Array(0);

    // 控制类 C2C push：QQ 自己不渲染，解码出来只会是脏元素。
    if (C2C_CONTROL_TYPES.has(msgType) && C2C_CONTROL_CMDS.has(c2cCmd)) continue;

    if (MESSAGE_TYPES.has(msgType)) {
      const event = messageEvent(raw, options);
      if (!event) continue; // 空消息（[空消息] 幽灵推送）
      if (options.dedup?.seenDuplicate(raw)) continue;
      out.push(event);
      continue;
    }

    if (options.dedup?.seenDuplicate(raw)) continue;

    out.push(
      registry.decode(raw) ?? {
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
  }

  return out;
}

/** 完整一帧：`MsgPush` 走业务解码，回执单独解，其余原样交给上层（KickNT 等）。 */
export function decodePushFrame(
  frame: { command: string; body: Uint8Array; seq: number },
  options: DecodePushOptions = {},
): PushEvent[] {
  if (frame.command === MSG_PUSH_CMD) return decodePushBody(frame.body, options);
  if (frame.command === CLIENT_MESSAGE_RECEIPT_CMD) {
    const receipt = decodeClientMessageReceipt(frame.body);
    if (receipt) return [receipt];
  }
  return [{ kind: 'other', command: frame.command, body: frame.body, seq: frame.seq }];
}

/**
 * 客户端消息回执。
 *
 * 信封（照 SnowLuma 实测）：`{1: 1}`、`{2: u16le = 0}`、`{4: u32le clientSeq}`、
 * `{8..: peerUid}`（长度在 `[1]`），尾部是 `SendMessageResponse`。只解出
 * 「哪个会话、哪条客户端序号被确认」，不在这里回查历史。
 */
export function decodeClientMessageReceipt(body: Uint8Array): PushClientReceiptEvent | null {
  if (body.length < 12) return null;
  const peerLength = body[1]!;
  const ackOffset = 8 + peerLength;
  if (
    body[0] !== 1 ||
    (body[2]! | (body[3]! << 8)) !== 0 ||
    peerLength < 3 ||
    peerLength > 128 ||
    ackOffset >= body.length
  ) {
    return null;
  }
  const peerUid = new TextDecoder().decode(body.subarray(8, ackOffset));
  const clientSequence = body[4]! | (body[5]! << 8) | (body[6]! << 16) | (body[7]! << 24);
  if (!/^u_[A-Za-z0-9_-]+$/.test(peerUid) || clientSequence === 0) return null;

  const ack = decode(SEND_MESSAGE_RESPONSE, body.subarray(ackOffset)) as {
    result?: number;
    reviewResult?: number;
    serverResult?: { code?: number };
    privateSequence?: number;
    groupSequence?: number;
    timestamp1?: number;
  };
  if ((ack.result ?? 0) !== 0 || (ack.reviewResult ?? 0) !== 0) return null;
  if ((ack.serverResult?.code ?? 0) !== 0) return null;
  if (!ack.privateSequence || (ack.groupSequence ?? 0) !== 0) return null;

  return {
    kind: 'client-receipt',
    time: ack.timestamp1 ?? Math.floor(Date.now() / 1000),
    peerUid,
    clientSequence,
    sequence: ack.privateSequence,
  };
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
  return bodies
    .map((raw) => messageEvent(raw, options))
    .filter((event): event is PushMessageEvent => event !== null);
}

function messageEvent(
  raw: RawMessageBody,
  options: DecodePushOptions,
): PushMessageEvent | null {
  const message = decodeMessageBody(raw);
  // 空消息（无元素、无 msgContent）是 QQ 的「[空消息]」幽灵推送。
  if (message.elements.length === 0 && (raw.body?.msgContent?.length ?? 0) === 0) {
    return null;
  }
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
