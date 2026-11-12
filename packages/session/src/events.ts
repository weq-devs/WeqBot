/**
 * bot 对外的**事件契约**。
 *
 * 这是整个项目最需要早点定下来的东西：OneBot 适配层、WeQ 的 UI、插件都消费它。
 * 三条纪律：
 *
 *   1. **只放语义，不放 wire 细节**：`seq` / `msg_id` 可以带，但不要把 raw SSO
 *      包头塞进来；需要原始字节的走 `event.raw` 显式字段。
 *   2. **不做 OneBot 词汇映射**：这里叫 `scene: 'group'`，不叫 `message_type`。
 *   3. **离线是一等事件**：被踢、心跳失效、主动关闭都必须报告 `reason`，否则
 *      上层无法决定「要不要重登 / 要不要提示用户」。
 */

import type { WeqBotError } from '@weqbot/common';
import type { DecodedDress } from '@weqbot/protocol';
import type { SessionState } from './state';

/** 会话级事件（不针对具体消息）。 */
export type SessionEvent =
  /** 状态机变化；每次 transition 都发，便于 UI 画进度。 */
  | { type: 'state'; from: SessionState; to: SessionState; at: number; detail?: string }
  /** 上线完成：注册被接受、心跳已起、推送已接通。 */
  | { type: 'online'; uin: string; at: number }
  /** 掉线。`kicked` = 服务端踢（同账号在别处登录 / 风控）。 */
  | { type: 'offline'; reason: OfflineReason; at: number; detail?: string }
  /** 一次心跳往返（native 上报，仅观测用）。 */
  | { type: 'heartbeat'; at: number; rttMs?: number }
  | { type: 'error'; error: WeqBotError; at: number };

export type OfflineReason =
  /** 服务端 `KickNT`。**正常情况下不该出现**：我们不与 QQ 抢登录。 */
  | 'kicked'
  /** 网络断 / 心跳超时。 */
  | 'network'
  /** 主动下线（用户关账号 / bot 停止）。 */
  | 'closed'
  /** 重登失败次数耗尽。 */
  | 'relogin-failed'
  /** 注册阶段就被拒（凭据失效 / 风控）。 */
  | 'register-failed';

export type MessageScene = 'private' | 'group' | 'temp' | 'guild';

export interface PeerRef {
  /** 群号 / 对方 uin / 频道 id。 */
  id: string;
  /** 群聊时的发送者 uid（`u_...`），私聊时与 `id` 对应。 */
  uid?: string;
  name?: string;
}

export interface InboundMessage {
  /** wire 上的 `msg_id`（OneBot 的 `message_id` 由适配层另做映射）。 */
  messageId: string;
  /** 会话内序号。 */
  seq: number;
  /** 秒级时间戳。 */
  time: number;
  scene: MessageScene;
  /** 私聊 = 对方；群聊 = 群；频道 = 子频道。 */
  peer: PeerRef;
  sender: PeerRef;
  self: { uin: string; uid?: string };
  /**
   * 解码后的元素列表，形状由 `@weqbot/protocol` 的 `decodeMessage` 定义
   * （`{ kind: 'text', textContent }` 这类以 `kind` 区分的对象）。
   *
   * 这里刻意不改写一层自有类型：入站解出来的对象要能**原样**交给
   * `buildSendElems` 再发出去（转发 / 搬运），多一层映射就多一处漂移。
   */
  elements: Record<string, unknown>[];
  /**
   * 发送者装扮：气泡 / 字体 / 挂件 itemId（0 = 未设置）。
   *
   * 与 `elements` 同源（`@weqbot/protocol` 的 `DecodedMessage`），历史消息、
   * 合并转发节点解出来的值一致，OneBot 适配层不需要再碰 wire。
   */
  dress?: DecodedDress;
  /** 原始 body（仅当 `SessionOptions.keepRaw` 打开时存在，诊断用）。 */
  raw?: Uint8Array;
}

export type NoticeEvent =
  | {
      type: 'notice';
      kind: 'group-member-increase' | 'group-member-decrease';
      at: number;
      group: PeerRef;
      member: PeerRef;
      operator?: PeerRef;
    }
  | {
      type: 'notice';
      kind: 'group-admin' | 'group-card' | 'group-name';
      at: number;
      group: PeerRef;
      member?: PeerRef;
      detail?: string;
    }
  | {
      type: 'notice';
      kind: 'message-recall';
      at: number;
      peer: PeerRef;
      sender?: PeerRef;
      messageId: string;
      operator?: PeerRef;
    }
  | { type: 'notice'; kind: 'friend-add'; at: number; friend: PeerRef }
  | { type: 'notice'; kind: 'poke'; at: number; peer: PeerRef; sender: PeerRef; target?: PeerRef }
  /** C2C 输入状态（`eventType` 1 = 输入中，3 = 讲话中）。 */
  | {
      type: 'notice';
      kind: 'input-status';
      at: number;
      peer: PeerRef;
      eventType: number;
      text: string;
    }
  | { type: 'notice'; kind: 'other'; at: number; name: string; detail?: string };

export type RequestEvent =
  | { type: 'request'; kind: 'friend'; at: number; from: PeerRef; comment?: string; flag: string }
  | {
      type: 'request';
      kind: 'group';
      at: number;
      group: PeerRef;
      from: PeerRef;
      comment?: string;
      flag: string;
      invite: boolean;
    };

/** 所有事件的联合。 */
export type BotEvent =
  | SessionEvent
  | { type: 'message'; message: InboundMessage }
  | NoticeEvent
  | RequestEvent;

/** 事件名 → payload 的映射，给 `TypedEventBus` 用。 */
export type BotEventMap = {
  event: BotEvent;
  state: Extract<SessionEvent, { type: 'state' }>;
  online: Extract<SessionEvent, { type: 'online' }>;
  offline: Extract<SessionEvent, { type: 'offline' }>;
  heartbeat: Extract<SessionEvent, { type: 'heartbeat' }>;
  message: InboundMessage;
  notice: NoticeEvent;
};
