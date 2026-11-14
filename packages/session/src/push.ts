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
import { IdentityCache } from './identity';

export interface PushBridgeOptions {
  /** 本账号 uin（十进制串）。 */
  selfUin: string;
  /** 本账号 uid（`u_...`），用于把自身消息与对方消息区分开。 */
  selfUid?: string;
  /** 保留入站原始 `PUSH_MSG_BODY`（诊断用，默认关）。 */
  keepRaw?: boolean;
  /**
   * 与 backend 共用的 uid ↔ uin 缓存。不传时自己建一个（单测便利），
   * 但生产上必须传：同一个 uid 在消息里观测到、在撤回通知里才用得上。
   */
  identity?: IdentityCache;
}

export interface PushBridgeResult {
  events: BotEvent[];
  /** 没有建模的推送（system / other），供诊断日志用。 */
  unhandled: PushEvent[];
}

export class PushBridge {
  readonly selfUin: string;
  readonly selfUid: string | undefined;
  readonly identity: IdentityCache;
  private readonly keepRaw: boolean;

  constructor(options: PushBridgeOptions) {
    this.selfUin = options.selfUin;
    this.selfUid = options.selfUid;
    this.keepRaw = options.keepRaw ?? false;
    this.identity = options.identity ?? new IdentityCache();
  }

  /** uid → uin。未观测到时返回 undefined。 */
  resolveUin(uid: string): string | undefined {
    return this.identity.uinOf(uid);
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
        case 'group-member':
          out.push({
            type: 'notice',
            kind:
              event.action === 'join' || event.action === 'self-join'
                ? 'group-member-increase'
                : 'group-member-decrease',
            at: event.time * 1000,
            group: { id: String(event.groupUin) },
            member:
              event.action === 'self-join'
                ? { id: this.selfUin, ...(this.selfUid ? { uid: this.selfUid } : {}) }
                : this.peerOfUid(event.memberUid),
            ...(event.operatorUid ? { operator: this.peerOfUid(event.operatorUid) } : {}),
          } satisfies NoticeEvent);
          break;
        case 'group-admin':
          out.push({
            type: 'notice',
            kind: 'group-admin',
            at: event.time * 1000,
            group: { id: String(event.groupUin) },
            member: this.peerOfUid(event.memberUid),
            detail: event.set ? 'set' : 'unset',
          } satisfies NoticeEvent);
          break;
        case 'group-request':
          out.push({
            type: 'request',
            kind: 'group',
            at: event.time * 1000,
            group: { id: String(event.groupUin) },
            from: this.peerOfUid(event.fromUid),
            ...(event.message ? { comment: event.message } : {}),
            flag: event.flag,
            invite: event.subType === 'invite',
          });
          break;
        case 'friend-request':
          out.push({
            type: 'request',
            kind: 'friend',
            at: event.time * 1000,
            from: this.peerOfUid(event.fromUid),
            ...(event.message ? { comment: event.message } : {}),
            flag: event.flag,
          });
          break;
        case 'friend-add':
          out.push({
            type: 'notice',
            kind: 'friend-add',
            at: event.time * 1000,
            friend: {
              ...this.peerOfUid(event.uid),
              ...(event.nickname ? { name: event.nickname } : {}),
            },
          } satisfies NoticeEvent);
          break;
        case 'poke':
          out.push({
            type: 'notice',
            kind: 'poke',
            at: event.time * 1000,
            peer: event.groupUin ? { id: String(event.groupUin) } : this.peerOfUid(event.fromUid),
            sender: this.peerOfUid(event.fromUid),
            ...(event.toUid ? { target: this.peerOfUid(event.toUid) } : {}),
          } satisfies NoticeEvent);
          break;
        case 'group-mute':
        case 'group-reaction':
        case 'group-essence':
        case 'client-receipt':
          out.push({
            type: 'notice',
            kind: 'other',
            at: event.time * 1000,
            name: event.kind,
            detail: describePushEvent(event),
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
      ...(message.head.clientSequence !== undefined
        ? { clientSequence: message.head.clientSequence }
        : {}),
      ...(message.head.ntMsgSeq !== undefined ? { ntMsgSeq: message.head.ntMsgSeq } : {}),
      ...(message.head.msgId ? { random: message.head.msgId } : {}),
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
    this.identity.observe(uid, uin);
  }
}

/** 没有专门 `NoticeEvent.kind` 的推送：给诊断日志一段可读的摘要。 */
function describePushEvent(
  event: Extract<
    PushEvent,
    { kind: 'group-mute' | 'group-reaction' | 'group-essence' | 'client-receipt' }
  >,
): string {
  switch (event.kind) {
    case 'group-mute':
      return `group=${event.groupUin} target=${event.targetUid} duration=${event.duration}`;
    case 'group-reaction':
      return `group=${event.groupUin} seq=${event.sequence} code=${event.code} count=${event.count}`;
    case 'group-essence':
      return `group=${event.groupUin} seq=${event.sequence} set=${event.set}`;
    case 'client-receipt':
      return `peer=${event.peerUid} clientSeq=${event.clientSequence} seq=${event.sequence}`;
  }
}
