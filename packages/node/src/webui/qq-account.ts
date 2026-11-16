/**
 * 账号数据目录的**纯推导**（不读库、不读内存）。
 *
 * QQ NT 在两端的账户目录命名规则不同：
 *
 * ```text
 * win32:       <数据根>/<uin>/nt_qq/nt_db/nt_msg.db
 * linux/macOS: <数据根>/nt_qq_<hash>/nt_db/nt_msg.db
 *              <hash> = md5(md5(uid) + "nt_kernel")   (小写 hex，无分隔符)
 * ```
 *
 * `hash` 用的是账号的**字符串 uid**（`u_...` 形态），不是数字 uin —— 这一点在 WeQ
 * 的 `packages/platform/src/linux/paths.ts:81-85` 有真机验证记录
 * （`u_LKt3AdAIMP-CUfn6ydzDzw` → `nt_qq_2472b597…425e4186`）。
 *
 * 用途只有一个：用户没配 `qq.dbPath` 时，仍能定位 `nt_msg.db` 去做
 * 「QQ 本体是否在线」的预检（`isQqLoggedIn`）。
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';

/** `<hash> = md5(md5(uid) + "nt_kernel")`，返回 `nt_qq_<hash>`。 */
export function accountDirName(uid: string): string {
  const inner = createHash('md5').update(uid, 'utf8').digest('hex');
  const hash = createHash('md5').update(`${inner}nt_kernel`, 'utf8').digest('hex');
  return `nt_qq_${hash}`;
}

export interface FindNtMsgDbOptions {
  platform?: NodeJS.Platform;
  /** 数据根（`QqPaths.dataRoot`）；为 null 时直接返回 null。 */
  dataRoot: string | null;
  /** win32 用；unix 上忽略。 */
  uin?: string;
  /** unix 用（`u_...` 字符串）；为空时无法推导。 */
  uid?: string;
  /** 便于测试注入；默认 `existsSync`。 */
  exists?: (path: string) => boolean;
}

/**
 * 定位某个账号的 `nt_msg.db`。
 *
 * 只返回**确实存在**的路径；推不出来或不存在都是 null（调用方据此跳过预检，
 * 而不是拿一个不存在的路径去探测）。
 */
export function findNtMsgDb(options: FindNtMsgDbOptions): string | null {
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const path = platform === 'win32' ? win32 : posix;
  if (!options.dataRoot) return null;

  if (platform === 'win32') {
    const uin = options.uin?.trim();
    if (!uin || !/^\d+$/.test(uin)) return null;
    const candidate = path.join(options.dataRoot, uin, 'nt_qq', 'nt_db', 'nt_msg.db');
    return exists(candidate) ? candidate : null;
  }

  const uid = options.uid?.trim();
  if (!uid) return null;
  const candidate = path.join(options.dataRoot, accountDirName(uid), 'nt_db', 'nt_msg.db');
  return exists(candidate) ? candidate : null;
}
