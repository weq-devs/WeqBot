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

/** OneBot 单连接的公共字段（与 `@weqbot/onebot` 的 `NetworkBase` 同形）。 */
interface ControlNetworkBase {
  name: string;
  /** false = 配置保留但不启动。 */
  enabled?: boolean;
  accessToken?: string;
  messageFormat: 'array' | 'string';
  reportSelfMessage: boolean;
}

export interface ControlWsServer extends ControlNetworkBase {
  host?: string;
  port: number;
  path?: string;
  role?: 'Api' | 'Event' | 'Universal';
}

export interface ControlWsClient extends ControlNetworkBase {
  /** 目标 ws:// / wss:// 地址；连不上按 `reconnectIntervalMs` 重连。 */
  url: string;
  role?: 'Api' | 'Event' | 'Universal';
  reconnectIntervalMs?: number;
}

export interface ControlHttpServer extends ControlNetworkBase {
  host?: string;
  port: number;
  path?: string;
  /** 同一个监听上是否同时接受 OneBot WS 客户端。 */
  enableWebSocket?: boolean;
}

export interface ControlHttpClient extends ControlNetworkBase {
  url: string;
  timeoutMs?: number;
}

/**
 * OneBot 配置（宿主持有、kernel 只执行）。
 *
 * 四类网络与 `@weqbot/onebot` 的 `OneBotNetworks` 一一对应；控制包自己声明一遍
 * 是为了不把 `onebot`（进而 `session` / `protocol`）拖进宿主的依赖图。
 * 两边的字段对齐由 `@weqbot/node` 的测试守着。
 */
export interface ControlOneBotConfig {
  networks: {
    wsServers: ControlWsServer[];
    wsClients: ControlWsClient[];
    httpServers: ControlHttpServer[];
    httpClients: ControlHttpClient[];
  };
  /** QQ 空间能力开关，默认开。 */
  qzone?: boolean;
  qzoneDomain?: string;
}

/** 一条网络当前的运行状态（来自 kernel 的实际监听，不是配置）。 */
export interface ControlOneBotListener {
  kind: 'ws-server' | 'ws-client' | 'http-server' | 'http-client';
  name: string;
  /** 监听地址（服务端）或目标地址（客户端）。 */
  endpoint: string;
  state: 'listening' | 'connected' | 'connecting' | 'stopped' | 'error';
  port?: number;
  clients?: number;
  error?: string;
}

/** `onebot.get` / `onebot.set` 的返回。 */
export interface ControlOneBotState {
  /** 是否配了 OneBot（false 时 `config` 为 null，网络全部未启动）。 */
  configured: boolean;
  /** 当前生效的配置；`accessToken` 已打码。 */
  config: ControlOneBotConfig | null;
  /** 实时监听；账号未上线时为空数组。 */
  listeners: ControlOneBotListener[];
}

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
  /**
   * 有头模式（mode 1）：宿主已经持有 QQ 本体会话，把这批物料交进来直接建会话。
   *
   * 与 {@link login} 的分界是「谁拥有账号的在线状态」：`login` 是我们自己注册上线
   * （QQ 必须离线），`attach` 只是搭 QQ 的 SSO 通道（QQ 必须在线）。两者互斥，
   * 一个进程只能成功一次。
   *
   * ⚠️ **mode 1 只发不收**：不发 `SsoInfoSync`、不注册，服务端不往这条连接推消息，
   * 因此 {@link CONTROL_EVENTS.onebot} 在本模式下**永远不会触发**。宿主要收消息
   * 得自己接别的来源（WeQ 用 `SsePushService` 轮询数据库）。这是设计边界：
   * 多一条事件通道只会让同一份消息有两个来源。
   *
   * 物料字段与 `@weqbot/bot` 的 `AttachMaterial` 一一对应，**不在这里 import 它**
   * —— control 包刻意保持零业务依赖（见文件头）。
   */
  attach: {
    params: {
      /** 正在运行、持有该账号会话的 QQ 进程。 */
      pid: number;
      /** 必须与进程绑定的 uin 一致；错号接入是最危险的失误。 */
      uin: string;
      uid: string;
      guid: string;
      /** a2 / d2 / d2Key，hex（大小写不敏感）。 */
      a2: string;
      d2: string;
      d2Key: string;
      /** QQ 自己的 SecToken（12 字符原文）。原样透传，不要重新生成。 */
      secToken?: string;
      subAppId: number;
      clientVersion?: string;
      qua?: string | null;
      /** 运行中 QQ 的 `wrapper.node`；签名必须用它。 */
      wrapperPath?: string;
      /** 设备档案，只用于 `status` 展示；有头模式不靠它注册。 */
      device?: DeviceProfile;
    };
    result: ControlStatus;
  };
  /**
   * 读 OneBot 配置与实时监听状态。
   *
   * `accessToken` 一律打码成 `'***'` —— 配置可以给页面看，令牌明文不出进程。
   */
  'onebot.get': { params: Record<string, never>; result: ControlOneBotState };
  /**
   * 改 OneBot 网络配置并**立即生效**（只重启适配器，不动会话）。
   *
   * 失败时旧配置会被恢复（`reloadOneBot` 的语义），错误里带
   * `{ network, kind, host, port }`，宿主可以定位到具体是哪一条。
   * 传 `null` = 停掉所有网络。
   */
  'onebot.set': {
    params: { config: ControlOneBotConfig | null };
    result: ControlOneBotState;
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
  /**
   * OneBot 事件（消息、通知、请求）。
   *
   * **仅 mode 2**：mode 1（`attach`）不注册、不收推送，这条事件不会出现。
   */
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
