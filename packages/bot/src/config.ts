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
  native?: {
    /**
     * QQ 的 `wrapper.node` 绝对路径。mode 2 的注册/签名必须用它；
     * 不传时由 native 的 `resolveQqWrapperPath` 探测。
     */
    wrapperPath?: string;
  };
  qq?: {
    /**
     * 账号 `nt_msg.db` 的绝对路径（进程层）。用于 `isQqLoggedIn` 预检：
     * QQ 本体在线时不允许 mode 2。不传时跳过检查并打 warn —— 这是产品红线，
     * 独立部署应尽量配置。
     */
    dbPath?: string;
  };
  secToken?: {
    /**
     * 原地轮换 `SecToken` 的间隔（ms），默认 24h。
     *
     * QQ 客户端的 token 缓存 TTL 是 48h；24h 轮换留一倍余量。`<= 0` 关闭自动轮换。
     */
    rotateMs?: number;
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
