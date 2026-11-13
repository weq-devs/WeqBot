/**
 * OneBot action 的业务后端。
 *
 * SnowLuma 的 action 直接调 `bridge.apis.<area>.<method>()`（183 个方法），
 * 那是它 core 层的形状。WeqBot 没有这一层，但也不需要照搬：**OneBot 层只声明
 * 它真正要的能力**，由 `@weqbot/bot` 用 `ProtocolClient` 实现，测试里可以换成
 * 桩。这样 onebot 包不依赖 native、不依赖会话生命周期，也能被单测。
 *
 * 约定：
 *   - 能做的返回结果；做不到的抛 {@link NotImplementedError}，适配层翻成
 *     `retcode 1404`（OneBot 的「不支持」），**不要**返回假数据；
 *   - 入参已是 OneBot 语义（QQ 号、群号、segment），后端负责换成协议调用。
 */

/** 后端没有实现这个能力。适配层把它翻成 `retcode 1404`。 */
export class NotImplementedError extends Error {
  readonly action: string;

  constructor(action: string) {
    super(`action 尚未实现：${action}`);
    this.name = 'NotImplementedError';
    this.action = action;
  }
}

/** OneBot 的 `send_*` 结果。`messageId` 由适配层分配，后端只回 QQ 侧定位信息。 */
export interface SendResult {
  /** QQ 侧消息序号（群内 seq / 私聊会话 seq）。 */
  sequence: number;
  /** 私聊的 client sequence；群聊为 0。 */
  clientSequence?: number;
  /** wire 层 random。 */
  random?: number;
  /** unix 秒。 */
  timestamp?: number;
}

export interface LoginInfo {
  userId: number;
  nickname: string;
  /** 账号 uid（`u_...`）。 */
  uid?: string;
}

export interface FriendInfo {
  userId: number;
  nickname: string;
  remark: string;
}

export interface GroupInfo {
  groupId: number;
  groupName: string;
  memberCount: number;
  maxMemberCount: number;
}

export interface GroupMemberInfo {
  groupId: number;
  userId: number;
  nickname: string;
  card: string;
  sex: 'male' | 'female' | 'unknown';
  age: number;
  area: string;
  joinTime: number;
  lastSentTime: number;
  level: string;
  role: 'owner' | 'admin' | 'member';
  title: string;
}

export interface StrangerInfo {
  userId: number;
  nickname: string;
  sex: 'male' | 'female' | 'unknown';
  age: number;
}

/** OneBot segment（已按 `message` 参数解析好）。 */
export type { Segment } from './segments';

/**
 * 撤回所需的服务端定位信息。
 *
 * 不同场景要的字段不同：群聊只要 `sequence`，私聊要 `clientSequence` +
 * `messageSequence` + `random` + `timestamp`。由适配层的 `MessageIdMap` 提供。
 */
export interface RecallTarget {
  isGroup: boolean;
  targetId: number;
  sequence: number;
  clientSequence?: number;
  random?: number;
  timestamp?: number;
}

/**
 * OneBot 适配层的业务能力面。
 *
 * 所有方法都**可选**：没实现的留 `undefined`，注册表据此决定是否注册该
 * action。这样 WeqBot 协议能力涨一点，后端实现一点，OneBot 面自动跟上，
 * 不会出现「注册了但一调就崩」的 action。
 */
export interface OneBotBackend {
  /** 登录信息（`get_login_info`）。 */
  getLoginInfo(): Promise<LoginInfo>;

  sendGroupMessage(groupId: number, message: import('./segments').Segment[]): Promise<SendResult>;
  sendPrivateMessage(
    userId: number,
    message: import('./segments').Segment[],
    tempGroupId?: number,
  ): Promise<SendResult>;

  recall(target: RecallTarget): Promise<void>;

  getFriendList?(): Promise<FriendInfo[]>;
  getGroupList?(): Promise<GroupInfo[]>;
  getGroupInfo?(groupId: number): Promise<GroupInfo>;
  getGroupMemberList?(groupId: number): Promise<GroupMemberInfo[]>;
  getGroupMemberInfo?(groupId: number, userId: number): Promise<GroupMemberInfo>;
  getStrangerInfo?(userId: number): Promise<StrangerInfo>;

  setGroupCard?(groupId: number, userId: number, card: string): Promise<void>;
  setGroupBan?(groupId: number, userId: number, duration: number): Promise<void>;
  setGroupWholeBan?(groupId: number, enable: boolean): Promise<void>;
  setGroupAdmin?(groupId: number, userId: number, enable: boolean): Promise<void>;
  setGroupName?(groupId: number, name: string): Promise<void>;
  setGroupKick?(groupId: number, userId: number, reject: boolean): Promise<void>;
  setGroupLeave?(groupId: number, dissolve: boolean): Promise<void>;

  sendLike?(userId: number, times: number): Promise<void>;
  sendPoke?(target: { groupId?: number; userId: number }): Promise<void>;

  setFriendAddRequest?(flag: string, approve: boolean, remark: string): Promise<void>;
  setGroupAddRequest?(flag: string, approve: boolean, reason: string): Promise<void>;

  /** `get_msg`：按 OneBot message_id 取缓存里的原始事件。 */
  getMessage?(messageId: number): Promise<Record<string, unknown> | null>;
  /** `can_send_image` / `can_send_record`。 */
  canSendImage?(): Promise<boolean>;
  canSendRecord?(): Promise<boolean>;
}

/** 后端实现了哪些能力的摘要，用于诊断与 `--print-capabilities`。 */
export function describeBackend(backend: OneBotBackend): string[] {
  const names: Array<keyof OneBotBackend> = [
    'getLoginInfo',
    'sendGroupMessage',
    'sendPrivateMessage',
    'recall',
    'getFriendList',
    'getGroupList',
    'getGroupInfo',
    'getGroupMemberList',
    'getGroupMemberInfo',
    'getStrangerInfo',
    'setGroupCard',
    'setGroupBan',
    'setGroupWholeBan',
    'setGroupAdmin',
    'setGroupName',
    'setGroupKick',
    'setGroupLeave',
    'sendLike',
    'sendPoke',
    'setFriendAddRequest',
    'setGroupAddRequest',
    'getMessage',
    'canSendImage',
    'canSendRecord',
  ];
  return names.filter((name) => typeof backend[name] === 'function');
}
