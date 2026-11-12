/**
 * 独立进程的默认 `CredentialVault` 实现。
 *
 * 落盘形态（`~/.weqbot/accounts/<uin>.json`）：
 *
 * ```json
 * { "version": 1, "account": { "uin": "...", "uid": "...", "a1": "<base64>", ... } }
 * ```
 *
 * ## 权限
 *
 * - 文件 `0600`、目录 `0700`（Linux 没有系统 keychain 时的降级路径）；
 * - 写盘走「临时文件 + rename」，崩溃不会留下半个 JSON；
 * - 读取时校验 `version`，不认识的版本直接报错，不做「猜字段」。
 *
 * ## 三端 keychain
 *
 * `SecretStore` 是宿主注入的加密出口（WeQ 用 Electron `safeStorage`，独立进程
 * 可用系统 keychain）。注入时 a1 走 `SecretStore`，JSON 里只留
 * `a1Ref`；未注入时 a1 直接落在 0600 文件里 —— 这是**明确接受的降级**，不是遗漏。
 */

import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WeqBotError } from '@weqbot/common';
import type { CredentialVault, StoredAccount } from './credentials';

/** 宿主注入的加密存储（keychain / safeStorage）。 */
export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface FileVaultOptions {
  /** 账号目录；调用方决定位置（默认建议 `~/.weqbot/accounts`）。 */
  dir: string;
  /** 有 keychain 时注入；没有就只靠 0600 文件权限。 */
  secrets?: SecretStore;
}

interface DiskEnvelope {
  version: 1;
  account: Omit<StoredAccount, 'a1'> & { a1?: string; a1Ref?: string };
}

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export class FileCredentialVault implements CredentialVault {
  private readonly dir: string;
  private readonly secrets: SecretStore | undefined;

  constructor(options: FileVaultOptions) {
    this.dir = options.dir;
    this.secrets = options.secrets;
  }

  async list(): Promise<{ uin: string; uid: string; lastOnlineAt?: number }[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (cause) {
      if (isMissing(cause)) return [];
      throw cause;
    }

    const out: { uin: string; uid: string; lastOnlineAt?: number }[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const account = await this.get(name.slice(0, -'.json'.length));
        if (!account) continue;
        out.push({
          uin: account.uin,
          uid: account.uid,
          ...(account.lastOnlineAt !== undefined ? { lastOnlineAt: account.lastOnlineAt } : {}),
        });
      } catch (cause) {
        throw new WeqBotError('CREDENTIAL_CORRUPT', `凭据文件 ${name} 无法读取`, { cause });
      }
    }
    return out.sort((a, b) => a.uin.localeCompare(b.uin));
  }

  async get(uin: string): Promise<StoredAccount | undefined> {
    assertUin(uin);
    let text: string;
    try {
      text = await readFile(this.pathOf(uin), 'utf8');
    } catch (cause) {
      if (isMissing(cause)) return undefined;
      throw cause;
    }

    let envelope: DiskEnvelope;
    try {
      envelope = JSON.parse(text) as DiskEnvelope;
    } catch (cause) {
      throw new WeqBotError('CREDENTIAL_CORRUPT', `${uin} 的凭据不是合法 JSON`, { cause });
    }
    if (envelope.version !== 1 || !envelope.account) {
      throw new WeqBotError('CREDENTIAL_CORRUPT', `${uin} 的凭据版本不受支持`);
    }

    const { a1, a1Ref, ...rest } = envelope.account;
    // 两种来源都存的是 base64(原始 a1 字节)：JSON 的 `a1`，或 keychain 里的值。
    const encoded = a1Ref ? await this.secrets?.get(a1Ref) : a1;
    if (!encoded) {
      throw new WeqBotError('CREDENTIAL_CORRUPT', `${uin} 的 a1 缺失或无法解密`);
    }

    return { ...rest, a1: new Uint8Array(Buffer.from(encoded, 'base64')) };
  }

  async put(account: StoredAccount): Promise<void> {
    assertUin(account.uin);
    await mkdir(this.dir, { recursive: true, mode: DIR_MODE });

    const secret = Buffer.from(account.a1).toString('base64');
    const { a1: _a1, ...rest } = account;
    let payload: DiskEnvelope['account'];

    if (this.secrets) {
      const ref = `weqbot:${account.uin}`;
      await this.secrets.set(ref, secret);
      payload = { ...rest, a1Ref: ref };
    } else {
      payload = { ...rest, a1: secret };
    }

    const envelope: DiskEnvelope = { version: 1, account: payload };
    const target = this.pathOf(account.uin);
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(envelope, null, 2)}\n`, { mode: FILE_MODE });
    await rename(tmp, target);
    await chmod(target, FILE_MODE);
  }

  async delete(uin: string): Promise<void> {
    assertUin(uin);
    if (this.secrets) await this.secrets.delete(`weqbot:${uin}`);
    await rm(this.pathOf(uin), { force: true });
  }

  private pathOf(uin: string): string {
    return join(this.dir, `${uin}.json`);
  }
}

function assertUin(uin: string): void {
  if (!/^\d{5,12}$/.test(uin)) {
    throw new WeqBotError('UNKNOWN', `非法 uin：${JSON.stringify(uin)}`);
  }
}

function isMissing(cause: unknown): boolean {
  return (
    typeof cause === 'object' && cause !== null && (cause as { code?: string }).code === 'ENOENT'
  );
}
