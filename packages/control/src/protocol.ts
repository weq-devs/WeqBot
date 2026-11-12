/**
 * desktop ↔ sidecar 控制通道的线上协议。
 *
 * 为什么需要一份契约包：sidecar 是**独立进程**（D6），desktop 要 spawn 它、给它凭据、
 * 收它的状态与推送事件。两侧都是 TS，但分属两个仓库/两个打包产物，所以类型必须住在
 * 一个双方都能依赖、又没有业务依赖的包里 —— 就是这个包。
 *
 * 传输是 NDJSON over stdio（`encodeEnvelope` / `ControlLineDecoder`），**不是** RPC 框架：
 * 我们用到的只有「请求-应答 + 单向事件」，一行一个 JSON 已经够，且 `text` 日志里可读。
 *
 * 不放进这个包的：socket 实现、supervisor、事件语义。前者在 `@weqbot/node`（sidecar 侧）
 * 与 WeQ desktop（宿主侧），后者在 `@weqbot/bot`。
 */

import type { DeviceProfile } from '@weqbot/wire';

/** 协议版本。破坏性变更时 +1，两侧都要检查。 */
export const CONTROL_PROTOCOL_VERSION = 1;

/** 信封的三种形态。 */
export type ControlKind = 'request' | 'response' | 'event';

interface ControlBase {
  v: typeof CONTROL_PROTOCOL_VERSION;
  kind: ControlKind;
}

export interface ControlRequest<P = unknown> extends ControlBase {
  kind: 'request';
  /** 调用方自增，只用于配对 response；事件不带 id。 */
  id: number;
  method: string;
  params?: P;
}

export interface ControlFailure {
  /** 通常直接是 `WeqBotErrorCode`；用 string 是为了宿主不必跟着升级。 */
  code: string;
  message: string;
  details?: unknown;
}

export interface ControlResponse<R = unknown> extends ControlBase {
  kind: 'response';
  id: number;
  ok: boolean;
  result?: R;
  /** 仅 `ok === false` 时出现。 */
  error?: ControlFailure;
}

export interface ControlEvent<D = unknown> extends ControlBase {
  kind: 'event';
  event: string;
  data?: D;
}

export type ControlEnvelope<D = unknown> = ControlRequest | ControlResponse | ControlEvent<D>;

/**
 * 方法表。sidecar 一个进程只有一个账号（硬约束 9），所以这里没有 uin 参数 ——
 * 账号由 spawn 时决定，控制通道拿不到第二个账号，结构上就杜绝了串号。
 */
export interface ControlMethods {
  /** 连通性探针；宿主用它确认子进程真的起来了。 */
  ping: { params: Record<string, never>; result: { pid: number; ts: number } };
  /** 当前状态与设备档案（不含 a1，凭据永不出 sidecar）。 */
  status: { params: Record<string, never>; result: ControlStatus };
  /**
   * 交付 a1 并开始上线。WeQ 场景由宿主在 quickLogin 成功后调用。
   *
   * `uid` 是 `openSession` 的必填字段：WeQ 的 `AccountConfig.uid` 是权威值。
   * native 的 EasyLogin 不回传 uid，所以宿主不传就只能依赖 vault 里已有的值。
   * `qqDbPath` 用于 `isQqLoggedIn` 预检（QQ 本体在线时拒绝 mode 2）。
   */
  login: {
    params: {
      a1: string;
      guid: string;
      uid?: string;
      device?: DeviceProfile;
      qqDbPath?: string;
    };
    result: ControlStatus;
  };
  /** 主动下线并退出进程；宿主在 `before-quit` 里调。 */
  shutdown: { params: { reason?: string }; result: null };
}

export type ControlMethod = keyof ControlMethods;
export type ControlParams<M extends ControlMethod> = ControlMethods[M]['params'];
export type ControlResult<M extends ControlMethod> = ControlMethods[M]['result'];

/** sidecar 暴露给宿主的只读状态。 */
export interface ControlStatus {
  uin: string | null;
  state: 'idle' | 'connecting' | 'online' | 'degraded' | 'closed';
  /** 会话 ID（native 分配）；未打开会话时 null。 */
  sessionId: number | null;
  /** 最近一次 native 上报的状态变化时间（ms）。 */
  lastEventAt: number | null;
  device: DeviceProfile | null;
}

/** 事件名。语义在 `@weqbot/bot` 的 `BotEventMap` 里定义，这里只固定通道上的名字。 */
export const CONTROL_EVENTS = {
  /** 会话状态机变化。 */
  state: 'state',
  /** 心跳 / 重连 / 被踢。 */
  heartbeat: 'heartbeat',
  /** OneBot 事件（消息、通知、请求）。 */
  onebot: 'onebot',
  /** sidecar 自己即将退出。 */
  bye: 'bye',
} as const;

export type ControlEventName = (typeof CONTROL_EVENTS)[keyof typeof CONTROL_EVENTS];

// ── 构造器（两侧共用，避免手写信封时漏字段） ──────────────────────────────

export function controlRequest<M extends ControlMethod>(
  id: number,
  method: M,
  params: ControlParams<M>,
): ControlRequest<ControlParams<M>> {
  return { v: CONTROL_PROTOCOL_VERSION, kind: 'request', id, method, params };
}

export function controlSuccess<R>(id: number, result: R): ControlResponse<R> {
  return { v: CONTROL_PROTOCOL_VERSION, kind: 'response', id, ok: true, result };
}

export function controlFailure(id: number, error: ControlFailure): ControlResponse<never> {
  return { v: CONTROL_PROTOCOL_VERSION, kind: 'response', id, ok: false, error };
}

export function controlEvent<D>(event: string, data: D): ControlEvent<D> {
  return { v: CONTROL_PROTOCOL_VERSION, kind: 'event', event, data };
}
