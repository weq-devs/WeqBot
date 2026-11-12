/**
 * bot 配置。
 *
 * 配置里**没有 a1**：凭据只走 `CredentialVault`。把 a1 写进 config.json 是
 * 最常见的泄漏路径（用户会把它贴进 issue），这里从类型上不给这个机会。
 */

import type { LogLevel } from '@weqbot/common';

export interface OneBotWsServerConfig {
  /** 监听端口（正向 WS：OneBot 客户端连进来）。 */
  port: number;
  host?: string;
  accessToken?: string;
  /** 事件上报格式，默认 array（v11 推荐）。 */
  messageFormat?: 'array' | 'string';
}

export interface OneBotWsClientConfig {
  /** 反向 WS：连到 OneBot 实现方。 */
  url: string;
  accessToken?: string;
  reconnect?: boolean;
}

export interface OneBotHttpConfig {
  port: number;
  host?: string;
  accessToken?: string;
}

export interface OneBotConfig {
  wsServer?: OneBotWsServerConfig;
  wsClient?: OneBotWsClientConfig[];
  http?: OneBotHttpConfig;
  /** 心跳间隔（ms），0 = 关。仅影响 OneBot `meta_event`，与 SSO 心跳无关。 */
  heartbeatMs?: number;
}

export interface BotConfig {
  account: {
    /** 账号 uin（十进制串）。凭据由 vault 按 uin 取。 */
    uin: string;
  };
  onebot?: OneBotConfig;
  log?: {
    level?: LogLevel;
  };
  /**
   * 保留入站原始 body（诊断用）。默认关：内存占用大，且 body 里有用户内容。
   */
  keepRaw?: boolean;
  /** 掉线重登的最大次数，默认 5。用尽后进入 `closed` 并报 `relogin-failed`。 */
  maxReloginAttempts?: number;
}
