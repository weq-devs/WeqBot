/**
 * 推送事件形状。
 *
 * 这一层**只做 wire → 语义**：一条 `MsgPush` 里可能同时有聊天消息和系统通知，
 * 统一摊平成 {@link PushEvent}[]。OneBot 词汇在 `@weqbot/onebot`，会话状态在
 * `@weqbot/session`，这里都不碰。
 *
 * `message`（{@link DecodedMessage}）与历史消息拉取共用同一个解码器 —— 漫游、
 * 合并转发节点、实时推送出来的结构必须一模一样，否则「转发一条收到的消息」会
 * 因为字段缺失而丢装扮/元素。
 */

import type { DecodedMessage } from '../msg/decode';

export type PushScene = 'private' | 'group' | 'temp';

/** 聊天消息推送。`message.dress` 已按 bubble/font/widget 聚合（见 `msg/decode`）。 */
export interface PushMessageEvent {
  kind: 'message';
  scene: PushScene;
  message: DecodedMessage;
  /** 原始 `PUSH_MSG_BODY` 字节；`keepRaw` 关闭时为 undefined。 */
  raw?: Uint8Array;
}

/** C2C「对方正在输入 / 正在讲话」。source: 0x210 subType 277。 */
export interface PushInputStatusEvent {
  kind: 'input-status';
  time: number;
  fromUid: string;
  toUid: string;
  /** 1 = 正在输入，3 = 正在讲话（其余值原样保留）。 */
  eventType: number;
  text: string;
}

/** 好友撤回（0x210 subType 138 = 对方撤回，139 = 自己撤回）。 */
export interface PushFriendRecallEvent {
  kind: 'friend-recall';
  time: number;
  fromUid: string;
  toUid: string;
  /** 会话内 client sequence。 */
  clientSequence: number;
  recalledBySelf: boolean;
}

/** 群撤回（0x2dc subType 17）。 */
export interface PushGroupRecallEvent {
  kind: 'group-recall';
  time: number;
  groupUin: number;
  operatorUid: string;
  authorUid: string;
  sequence: number;
}

/**
 * 未建模的系统推送：保留 msgType / subType / 原始 content。
 *
 * 群成员变动、加群请求、戳一戳、群名片变更等都先落这里，P4 做 OneBot 映射时
 * 再逐类提升成具体事件 —— 不猜 schema，也不丢字节。
 */
export interface PushSystemEvent {
  kind: 'system';
  msgType: number;
  subType: number;
  time: number;
  fromUin: number;
  fromUid: string;
  toUin: number;
  groupUin: number;
  content: Uint8Array;
}

/** 非 `MsgPush` 的 SSO 推送（KickNT / InfoSyncPush 等）。 */
export interface PushOtherEvent {
  kind: 'other';
  command: string;
  body: Uint8Array;
  seq: number;
}

export type PushEvent =
  | PushMessageEvent
  | PushInputStatusEvent
  | PushFriendRecallEvent
  | PushGroupRecallEvent
  | PushSystemEvent
  | PushOtherEvent;
