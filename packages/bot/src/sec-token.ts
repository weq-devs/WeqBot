/**
 * mode2 的 `SecToken` 生成。
 *
 * 2026-11-13 的逆向结论（`nt_helper/docs/sectoken-generation-reverse-20261113.md`）：
 *
 * - QQ 在**登录时**用 `/dev/urandom` 生成一条 12 字符、字符集 `[A-Za-z0-9]`
 *   的 token，按 uin 缓存 48h；签名时只查表，不是每包生成，也不是服务端下发；
 * - 同一 uin 两次登录会得到不同 token，所以它既不是账号固定值，也不是设备固定值。
 *
 * 因此这里按「每次登录生成一条新的 12 字符 base62」实现。**不要**用
 * `Buffer.toString('base64')`：base64 会带 `+` / `/`，不在真实 token 的字符集里。
 *
 * 过期策略不在这里：48h 是 QQ 客户端的缓存 TTL。mode2 长跑由 `BotSession`
 * 在 24h 左右做一次重新登录（quickLogin → 新 token → openSession），这样即使
 * 服务端也校验 token 年龄，也永远在窗口内。
 */

import { randomBytes } from 'node:crypto';

/** 真机 token：12 字符，`[A-Za-z0-9]`。 */
const SEC_TOKEN_LENGTH = 12;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/** 62 的整数倍上限：≥ 它的字节丢弃，避免取模偏置。 */
const UNBIASED_LIMIT = 256 - (256 % ALPHABET.length);

export function generateSecToken(random: (size: number) => Uint8Array = randomBytes): string {
  let token = '';
  while (token.length < SEC_TOKEN_LENGTH) {
    const bytes = random(16);
    for (const byte of bytes) {
      if (byte >= UNBIASED_LIMIT) continue;
      token += ALPHABET[byte % ALPHABET.length];
      if (token.length === SEC_TOKEN_LENGTH) break;
    }
  }
  return token;
}
