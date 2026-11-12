/**
 * 凭据存储契约。
 *
 * ## 存什么
 *
 * **只存 a1 + guid + 设备档案**（外加 uin/uid 作为索引）。a2 / d2 / d2Key 是
 * `quickLogin` 的派生物，掉线重登时重新换就行 —— 存它们只会制造「票据过期但状态
 * 显示在线」的假象。这也是 mode2 不需要 a2 续期（ExchangeEmp）的原因。
 *
 * ## 不存什么
 *
 * - 数据库密钥 / `keyMeta`：bot 不读 QQ 库；
 * - 扫描来的会话物料：**永远不做扫描凭据的 mode2**（见 TODO「硬约束」）。
 *
 * ## 落盘形态
 *
 * 实现由宿主决定（WeQ 用 Electron safeStorage，独立进程用 `~/.weqbot/accounts`）。
 * 这一层只给接口 + 版本号：文件格式改了就升 `version` 并写迁移，不做「猜字段」。
 */

import type { DeviceProfile } from '@weqbot/wire';

/** 一个账号的持久化内容。 */
export interface StoredAccount {
  /** 账号 uin（十进制串），主键。 */
  uin: string;
  uid: string;
  /** a1 原文（敏感）。 */
  a1: Uint8Array;
  /** 设备 guid，32 位小写 hex。 */
  guid: string;
  /** 设备档案：跨重启必须稳定，否则签名 / 风控行为会变。 */
  device: DeviceProfile;
  /** 上次成功上线的时间（ms），仅用于展示。 */
  lastOnlineAt?: number;
  /** 上次成功登录时用的 a1 是哪来的（诊断：迁移 / 换机）。 */
  a1Origin?: 'login-db' | 'qr' | 'manual';
}

export interface AccountSummary {
  uin: string;
  uid: string;
  lastOnlineAt?: number;
}

export interface CredentialVault {
  list(): Promise<AccountSummary[]>;
  /** 取不到返回 undefined（不是抛错）。 */
  get(uin: string): Promise<StoredAccount | undefined>;
  put(account: StoredAccount): Promise<void>;
  /** 删掉账号的凭据（不等于停止 bot）。 */
  delete(uin: string): Promise<void>;
}

/** 磁盘信封格式；`version` 之外的一切都可能变。 */
export interface CredentialEnvelope {
  version: 1;
  account: StoredAccount;
}
