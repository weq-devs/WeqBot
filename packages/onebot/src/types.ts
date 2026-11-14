/**
 * OneBot v11 线上类型。
 *
 * 搬运自 SnowLuma `packages/onebot/src/types.ts`（2026-11-13），去掉 SnowLuma
 * 特有的通知渠道 / 历史回填配置，保留网络与响应的形状。
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export interface JsonObject {
  [key: string]: JsonValue | undefined;
}
export type JsonArray = JsonValue[];

/** OneBot 响应信封。`retcode` 约定见 {@link RETCODE}。 */
export interface ApiResponse {
  status: 'ok' | 'failed';
  retcode: number;
  data: JsonValue;
  echo?: JsonValue;
  wording?: string;
  /** 流式接口用；普通响应不带。 */
  message?: string;
  stream?: string;
}

export interface OneBotRequest {
  action: string;
  params?: JsonObject;
  echo?: JsonValue;
}

/** WS 连接角色：只收 action（Api）、只收事件（Event）或两者都收（Universal）。 */
export type WsRole = 'Api' | 'Event' | 'Universal';

export type MessageFormat = 'array' | 'string';

export interface NetworkBase {
  /** 配置名，日志与诊断用。 */
  name: string;
  /** `false` 时保留配置但不启动。默认 `true`。 */
  enabled?: boolean;
  accessToken?: string;
  /** 该连接的事件上报格式。 */
  messageFormat: MessageFormat;
  /** 是否下发自身发出的消息（`post_type = message_sent`）。 */
  reportSelfMessage: boolean;
}

/**
 * 单帧入站上限（字节）。超过的连接以 1009 关闭。
 *
 * 不放进 {@link NetworkBase}：HTTP client 没有 WS 传输，存了也不用更糟。
 */
export interface WsFrameLimitConfig {
  maxPayloadBytes?: number;
}

export interface HttpServerNetwork extends NetworkBase, WsFrameLimitConfig {
  host?: string;
  port: number;
  path?: string;
  /** 在同一个 HTTP 监听上接受 OneBot WS 客户端。 */
  enableWebSocket?: boolean;
}

export interface HttpClientNetwork extends NetworkBase {
  url: string;
  timeoutMs?: number;
}

export interface WsServerNetwork extends NetworkBase, WsFrameLimitConfig {
  host?: string;
  port: number;
  path?: string;
  role?: WsRole;
}

export interface WsClientNetwork extends NetworkBase, WsFrameLimitConfig {
  url: string;
  role?: WsRole;
  reconnectIntervalMs?: number;
}

/**
 * 网络配置：**多服务**。
 *
 * 每类都是数组 —— 一个账号可以同时挂多个正向 WS、多个反向 WS、多个 HTTP 监听，
 * 与 SnowLuma 的 `OneBotNetworks` 同形。这是 P4 必须支持的（用户明确要求）。
 */
export interface OneBotNetworks {
  httpServers: HttpServerNetwork[];
  httpClients: HttpClientNetwork[];
  wsServers: WsServerNetwork[];
  wsClients: WsClientNetwork[];
}

/** 每个账号一份 OneBot 配置。 */
export interface OneBotConfig {
  networks: OneBotNetworks;
  /**
   * QQ 空间 action 开关，默认开。关掉时 `qzone` 能力不注册（凭据也不会被换取）。
   * 空间是主动写能力，暴露给不可信客户端的部署应当关闭。
   */
  qzone?: boolean;
  /** 空间 cgi 的域，默认 `qzone.qq.com`。 */
  qzoneDomain?: string;
}

/** 内部记录：一条消息在 QQ 侧的定位信息（`get_msg` / 撤回 / 引用都要）。 */
export interface MessageMeta {
  isGroup: boolean;
  targetId: number;
  sequence: number;
  /** `sequence` 是否已被 QQ 确认、可以拿去做协议操作。 */
  sequenceAuthoritative: boolean;
  eventName: string;
  clientSequence: number;
  privateDirection?: 'incoming' | 'outgoing';
  random: number;
  timestamp: number;
}

/** 只有能安全回传给 QQ 的 sequence 才算权威。 */
export function hasAuthoritativeSequence(
  meta: MessageMeta | null | undefined,
): meta is MessageMeta {
  return (
    meta?.sequenceAuthoritative === true && Number.isInteger(meta.sequence) && meta.sequence > 0
  );
}

/** OneBot 的 `get_login_info` 结果。 */
export interface LoginInfo {
  user_id: number;
  nickname: string;
}

/** 账号的静态信息；由宿主在启动时注入。 */
export interface OneBotIdentity {
  uin: string;
  /** 账号 uid（`u_...`）。 */
  uid?: string;
  nickname?: string;
}

export const RETCODE = {
  ACTION_FAILED: 100,
  INTERNAL_ERROR: 1200,
  BAD_REQUEST: 1400,
  UNKNOWN_ACTION: 1404,
} as const;

export function okResponse(data: JsonValue = null): ApiResponse {
  return { status: 'ok', retcode: 0, data };
}

export function failedResponse(retcode: number, wording: string): ApiResponse {
  return { status: 'failed', retcode, data: null, wording };
}
