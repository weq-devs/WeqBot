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
 * ## 账号分组
 *
 * 两个组**严格隔离**，各自有独立的设备身份（guid），同一个 uin 可以在两组里各存
 * 一份互不覆盖：
 *
 * | 组 | 是谁 | guid 从哪来 | a1 从哪来 |
 * | --- | --- | --- | --- |
 * | `local` | 本机账号：QQ 本体在这台机器登录过 | 本机数据根（QQ 自己的设备身份） | `login.db`，轮换后写回 |
 * | `self` | 自主账号：扫码登录产生的新身份 | 首次扫码时随机生成并持久化 | vault |
 *
 * 分开的原因不是洁癖：混用 guid 会让服务端把「自主账号」看成这台机器上的 QQ，
 * 于是本机 QQ 一登录就可能把 bot 顶下线，反之亦然。分组之后两边的设备指纹、
 * a1 轮换、失效清理都各走各的。
 *
 * ## 落盘形态
 *
 * 实现由宿主决定（WeQ 用 Electron safeStorage，独立进程用 `~/.weqbot/accounts`）。
 * 这一层只给接口 + 版本号：文件格式改了就升 `version` 并写迁移，不做「猜字段」。
 */

import type { DeviceProfile } from '@weqbot/wire';

/**
 * 账号分组。
 *
 * - `local`：本机账号。uid / guid 都复用本机 QQ 的那一份（`login.db` + 数据根）；
 * - `self`：自主账号。guid 是首次扫码时生成的随机值，之后一直用它。
 */
export type AccountGroup = 'local' | 'self';

/** 一个账号的持久化内容。 */
export interface StoredAccount {
  /** 账号 uin（十进制串），主键。 */
  uin: string;
  uid: string;
  /** a1 原文（敏感）。 */
  a1: Uint8Array;
  /** 设备 guid，32 位小写 hex。本机组 = 本机 guid，自主组 = 自持随机 guid。 */
  guid: string;
  /** 账号属于哪一组。决定用哪份设备身份，不能混。 */
  group: AccountGroup;
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
  /** 这一条属于哪个组（列表要按组分开展示）。 */
  group: AccountGroup;
  lastOnlineAt?: number;
}

export interface CredentialVault {
  /** 只列某一组；省略 = 全部组。 */
  list(group?: AccountGroup): Promise<AccountSummary[]>;
  /**
   * 取不到返回 undefined（不是抛错）。
   *
   * `group` 省略时按 `self` 取：自主凭据是默认的持久化对象，本机账号按 uin
   * 直接读 `login.db`，不依赖 vault 里的镜像。
   */
  get(uin: string, group?: AccountGroup): Promise<StoredAccount | undefined>;
  put(account: StoredAccount): Promise<void>;
  /** 删掉账号的凭据（不等于停止 bot）；只删指定组，另一组原样保留。 */
  delete(uin: string, group?: AccountGroup): Promise<void>;
}

/** 磁盘信封格式；`version` 之外的一切都可能变。 */
export interface CredentialEnvelope {
  version: 1;
  account: StoredAccount;
}

/**
 * 把 vault 限定到一个组。
 *
 * 给 `createBot` 这类只认 uin 的调用方用：它内部的 `vault.get(uin)` / a1 轮换
 * 写回都会落到同一个组，不需要知道分组的存在，也就不会把自主账号的轮换 a1
 * 写进本机组。
 */
export function groupScopedVault(vault: CredentialVault, group: AccountGroup): CredentialVault {
  return {
    list: (scoped) => vault.list(scoped ?? group),
    get: (uin, scoped) => vault.get(uin, scoped ?? group),
    put: (account) => vault.put({ ...account, group }),
    delete: (uin, scoped) => vault.delete(uin, scoped ?? group),
  };
}
