/**
 * 推送 → `BotEvent` 的翻译层。
 *
 * 只做「协议语义 → 会话语义」的搬运：
 *   - `PushMessageEvent` → {@link InboundMessage}（装扮、元素原样带过去）；
 *   - 输入状态 / 撤回 → notice；
 *   - `system` / `other` 暂不建模，交给调用方打日志（OneBot 映射在 P4）。
 *
 * 这里维护一个 **uid → uin 缓存**：输入状态、撤回这类系统推送只带 uid，
 * 而 OneBot / WeQ 都需要 uin。缓存来源是聊天消息里的 `sender` / `session`，
 * 属于「观测」，不是持久化映射（重启后靠首条消息重建）。
 */

import type { PushEvent } from '@weqbot/protocol';
import { decodePushFrame } from '@weqbot/protocol';
import type { PushFrame } from '@weqbot/wire';
import type { BotEvent, InboundMessage, NoticeEvent, PeerRef } from './events';

export interface PushBridgeOptions {
  /** 本账号 uin（十进制串）。 */
  selfUin: string;
  /** 本账号 uid（`u_...`），用于把自身消息与对方消息区分开。 */
  selfUid?: string;
  /** 保留入站原始 `PUSH_MSG_BODY`（诊断用，默认关）。 */
  keepRaw?: boolean;
}

export interface PushBridgeResult {
  events: BotEvent[];
  /** 没有建模的推送（system / other），供诊断日志用。 */
  unhandled: PushEvent[];
}

export class PushBridge {
  readonly selfUin: string;
  readonly selfUid: string | undefined;
  private readonly keepRaw: boolean;
  private readonly uinByUid = new Map<string, string>();

  constructor(options: PushBridgeOptions) {
    this.selfUin = options.selfUin;
    this.selfUid = options.selfUid;
    this.keepRaw = options.keepRaw ?? false;
  }

  /** uid → uin。未观测到时返回 undefined。 */
  resolveUin(uid: string): string | undefined {
    return uid ? this.uinByUid.get(uid) : undefined;
  }

  /** 翻译一帧 native 推送。 */
  handle(frame: PushFrame): PushBridgeResult {
    return this.translate(decodePushFrame(frame, { keepRaw: this.keepRaw }));
  }

  private translate(events: readonly PushEvent[]): PushBridgeResult {
    const out: BotEvent[] = [];
    const unhandled: PushEvent[] = [];

    for (const event of events) {
      switch (event.kind) {
        case 'message':
          out.push(this.messageEvent(event));
          break;
        case 'input-status':
          out.push({
            type: 'notice',
            kind: 'input-status',
            at: event.time * 1000,
            peer: this.peerOfUid(event.fromUid),
            eventType: event.eventType,
            text: event.text,
          } satisfies NoticeEvent);
          break;
        case 'friend-recall':
          out.push({
            type: 'notice',
            kind: 'message-recall',
            at: event.time * 1000,
            peer: this.peerOfUid(event.recalledBySelf ? event.toUid : event.fromUid),
            ...(event.recalledBySelf ? { sender: this.peerOfUid(event.toUid) } : {}),
            messageId: String(event.clientSequence),
          } satisfies NoticeEvent);
          break;
        case 'group-recall':
          out.push({
            type: 'notice',
            kind: 'message-recall',
            at: event.time * 1000,
            peer: { id: String(event.groupUin) },
            ...(event.authorUid ? { sender: this.peerOfUid(event.authorUid) } : {}),
            messageId: String(event.sequence),
            ...(event.operatorUid ? { operator: this.peerOfUid(event.operatorUid) } : {}),
          } satisfies NoticeEvent);
          break;
        default:
          unhandled.push(event);
      }
    }

    return { events: out, unhandled };
  }

  private messageEvent(event: Extract<PushEvent, { kind: 'message' }>): BotEvent {
    const { message, scene } = event;
    this.observe(message.session.uid, message.session.uin);
    this.observe(message.sender.uid, message.sender.uin);

    const sender: PeerRef = {
      id: String(message.sender.uin),
      ...(message.sender.uid ? { uid: message.sender.uid } : {}),
      ...(message.sender.name ? { name: message.sender.name } : {}),
    };

    const peer: PeerRef =
      scene === 'group'
        ? {
            id: String(message.session.uin),
            ...(message.session.uid ? { uid: message.session.uid } : {}),
            ...(message.session.name ? { name: message.session.name } : {}),
          }
        : {
            id: String(message.sender.uin),
            ...(message.sender.uid ? { uid: message.sender.uid } : {}),
          };

    const inbound: InboundMessage = {
      messageId: String(message.head.msgId),
      seq: message.head.sequence,
      time: message.head.timestamp,
      scene,
      peer,
      sender,
      self: { uin: this.selfUin, ...(this.selfUid ? { uid: this.selfUid } : {}) },
      elements: message.elements,
      dress: message.dress,
      ...(event.raw ? { raw: event.raw } : {}),
    };

    return { type: 'message', message: inbound };
  }

  private peerOfUid(uid: string): PeerRef {
    const uin = this.resolveUin(uid);
    return uin ? { id: uin, uid } : { id: uid, uid };
  }

  private observe(uid: string, uin: number): void {
    if (!uid || !Number.isSafeInteger(uin) || uin <= 0) return;
    this.uinByUid.set(uid, String(uin));
  }
}
