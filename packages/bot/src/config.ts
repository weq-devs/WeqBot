/**
 * bot 配置。
 *
 * 配置里**没有 a1**：凭据只走 `CredentialVault`。把 a1 写进 config.json 是
 * 最常见的泄漏路径（用户会把它贴进 issue），这里从类型上不给这个机会。
 */

import type { LogLevel } from '@weqbot/common';
import type { OneBotConfig } from '@weqbot/onebot';

/** OneBot 配置的别名，避免与 `config.onebot` 字段名混淆。 */
export type BotOneBotConfig = OneBotConfig;

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
     *
     * 控制台（`@weqbot/node`）会在这个值为空时，按 QQ 数据目录 + 账号推导出
     * 同一个路径再传进来；本包不自己做磁盘探测。
     */
    dbPath?: string;
    /**
     * QQ 安装根（含 `QQ.exe` / `qq` 的目录，macOS 是 `QQ.app`）。
     *
     * **bot 本身不读它** —— 这是给控制台的环境探测用的提示，避免非标准安装时
     * 用户只能靠环境变量。真正影响上线的是 `native.wrapperPath`。
     */
    installDir?: string;
    /** QQ 数据根（`~/.config/QQ` / `…\Tencent Files`）。同样是控制台侧提示。 */
    dataDir?: string;
  };
  session?: {
    /**
     * 首屏同步的额外等待（ms），默认 15s。
     *
     * native 的 `openSession` 自己等 15s；慢账号的 `InfoSyncPush` 可能更晚到。
     * 这里再等一段（轮询 `getSession`），拿到了就正常上线，不把「稍慢」
     * 当成注册失败去反复重登。等不到仍然报 `REGISTER_FAILED`，**不会假装在线**。
     */
    syncGraceMs?: number;
  };
  secToken?: {
    /**
     * 原地轮换 `SecToken` 的间隔（ms），默认 24h。
     *
     * QQ 客户端的 token 缓存 TTL 是 48h；24h 轮换留一倍余量。`<= 0` 关闭自动轮换。
     */
    rotateMs?: number;
  };
  /**
   * OneBot v11 适配配置。**多服务**：每类网络都是数组（正向 WS / 反向 WS /
   * HTTP 服务端 / HTTP 上报可同时存在）。不传则不启动 OneBot。
   */
  onebot?: BotOneBotConfig;
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
