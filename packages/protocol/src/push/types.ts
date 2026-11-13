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

/** 群成员变动（33 入群 / 34 退群 / 85 自己入群）。 */
export interface PushGroupMemberEvent {
  kind: 'group-member';
  time: number;
  groupUin: number;
  memberUid: string;
  operatorUid: string;
  action: 'join' | 'leave' | 'disband' | 'self-join';
  /** 入群方式（approve / invite）；退群事件为 undefined。 */
  joinType?: 'approve' | 'invite';
  /** 退群原因。 */
  leaveType?: 'leave' | 'kick' | 'disband';
}

/** 群管理员变更（44）。 */
export interface PushGroupAdminEvent {
  kind: 'group-admin';
  time: number;
  groupUin: number;
  memberUid: string;
  set: boolean;
}

/** 入群申请 / 邀请（84 / 525 / 87）。`flag` 回填 `set_group_add_request`。 */
export interface PushGroupRequestEvent {
  kind: 'group-request';
  time: number;
  groupUin: number;
  fromUid: string;
  invitedUid?: string;
  subType: 'add' | 'invite';
  message: string;
  flag: string;
}

/** 好友申请（0x210/35）。 */
export interface PushFriendRequestEvent {
  kind: 'friend-request';
  time: number;
  fromUid: string;
  targetUid: string;
  message: string;
  flag: string;
}

/** 新好友（0x210/179、226）。 */
export interface PushFriendAddEvent {
  kind: 'friend-add';
  time: number;
  uid: string;
  toUid: string;
  nickname: string;
}

/** 戳一戳（0x210/290 私聊、0x2dc/20 群聊）。 */
export interface PushPokeEvent {
  kind: 'poke';
  time: number;
  fromUid: string;
  toUid: string;
  groupUin?: number;
  action?: string;
  suffix?: string;
}

/** 群禁言（0x2dc/12）；`duration = 0` 是解除禁言。 */
export interface PushGroupMuteEvent {
  kind: 'group-mute';
  time: number;
  groupUin: number;
  targetUid: string;
  operatorUid: string;
  duration: number;
}

/** 群表情回应（0x2dc/16，field13=35）。 */
export interface PushGroupReactionEvent {
  kind: 'group-reaction';
  time: number;
  groupUin: number;
  sequence: number;
  code: string;
  count: number;
  operatorUid: string;
  added: boolean;
}

/** 群精华（0x2dc/21）。 */
export interface PushGroupEssenceEvent {
  kind: 'group-essence';
  time: number;
  groupUin: number;
  sequence: number;
  operatorUid: string;
  memberUin: number;
  set: boolean;
}

/** 客户端消息回执（`ClientMessageReceipt` 命令）：服务端确认了本机发出的私聊消息。 */
export interface PushClientReceiptEvent {
  kind: 'client-receipt';
  time: number;
  peerUid: string;
  clientSequence: number;
  sequence: number;
}

/**
 * 未建模的系统推送：保留 msgType / subType / 原始 content。
 *
 * 群名片变更、灰条、在线设备快照等都先落这里；不猜 schema，也不丢字节。
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
  | PushGroupMemberEvent
  | PushGroupAdminEvent
  | PushGroupRequestEvent
  | PushFriendRequestEvent
  | PushFriendAddEvent
  | PushPokeEvent
  | PushGroupMuteEvent
  | PushGroupReactionEvent
  | PushGroupEssenceEvent
  | PushClientReceiptEvent
  | PushSystemEvent
  | PushOtherEvent;
