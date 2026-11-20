/**
 * 独立进程的默认 `CredentialVault` 实现。
 *
 * 落盘形态（`~/.weqbot/accounts/<group>-<uin>.json`）：
 *
 * ```json
 * { "version": 1, "account": { "uin": "...", "uid": "...", "group": "self", "a1": "<base64>", ... } }
 * ```
 *
 * ## 为什么要带组前缀
 *
 * 同一个 uin 可能既是「本机账号」（QQ 本体登录过，走 `login.db`）又是「自主账号」
 * （扫码登录，自持 guid）。两份凭据的设备身份完全不同，覆盖任何一份都会让另一边
 * 拿着错的 guid 去登录（服务端直接当成换设备）。所以文件名按 `<组>-<uin>.json`
 * 分开，`get` / `delete` 也只操作指定的那一组。
 *
 * 旧版本的单文件 `<uin>.json` 仍然能读：读的时候按 `a1Origin` 推断组
 * （`login-db` → 本机，其余 → 自主），`put` 时写到新文件名并清掉旧文件。
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
import type { AccountGroup, AccountSummary, CredentialVault, StoredAccount } from './credentials';

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

interface DiskAccount extends Omit<StoredAccount, 'a1' | 'group'> {
  /** 旧文件没有 `group`，读的时候按 `a1Origin` 推断。 */
  group?: AccountGroup;
  a1?: string;
  a1Ref?: string;
}

interface DiskEnvelope {
  version: 1;
  account: DiskAccount;
}

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
/** keychain 里的键前缀；旧版是 `weqbot:<uin>`，新键带组。 */
const SECRET_PREFIX = 'weqbot:';
const GROUPS: readonly AccountGroup[] = ['local', 'self'];
const ACCOUNT_FILE = /^(?:(local|self)-)?(\d{5,12})\.json$/;

export class FileCredentialVault implements CredentialVault {
  private readonly dir: string;
  private readonly secrets: SecretStore | undefined;

  constructor(options: FileVaultOptions) {
    this.dir = options.dir;
    this.secrets = options.secrets;
  }

  async list(group?: AccountGroup): Promise<AccountSummary[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (cause) {
      if (isMissing(cause)) return [];
      throw cause;
    }

    const out: AccountSummary[] = [];
    const seen = new Set<string>();
    for (const name of names) {
      const match = ACCOUNT_FILE.exec(name);
      if (!match) continue;
      const [, prefix, uin] = match;
      try {
        // 带前缀的文件直接知道组；旧文件名要读一次才能推断。
        const resolved = prefix ? (prefix as AccountGroup) : await this.groupOfLegacy(uin!);
        if (!resolved) continue;
        if (group && resolved !== group) continue;
        const key = `${resolved}:${uin}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const account = await this.get(uin!, resolved);
        if (!account) continue;
        out.push({
          uin: account.uin,
          uid: account.uid,
          group: account.group,
          ...(account.lastOnlineAt !== undefined ? { lastOnlineAt: account.lastOnlineAt } : {}),
        });
      } catch (cause) {
        if (cause instanceof WeqBotError) throw cause;
        throw new WeqBotError('CREDENTIAL_CORRUPT', `凭据文件 ${name} 无法读取`, { cause });
      }
    }
    return out.sort((a, b) => a.uin.localeCompare(b.uin) || a.group.localeCompare(b.group));
  }

  async get(uin: string, group: AccountGroup = 'self'): Promise<StoredAccount | undefined> {
    assertUin(uin);
    assertGroup(group);

    let raw = await this.readAccountFile(this.pathOf(uin, group));
    if (!raw) {
      // 旧布局：单文件、组在内容里。推断出的组对不上时**当作不存在** ——
      // 拿本机账号的凭据去当自主账号用，正是分组要禁止的事。
      const legacy = await this.readAccountFile(this.legacyPathOf(uin));
      if (legacy && inferGroup(legacy) === group) raw = legacy;
    }
    if (!raw) return undefined;

    // 两种来源都存的是 base64(原始 a1 字节)：JSON 的 `a1`，或 keychain 里的值。
    const encoded = raw.a1Ref ? await this.secrets?.get(raw.a1Ref) : raw.a1;
    if (!encoded) {
      throw new WeqBotError('CREDENTIAL_CORRUPT', `${uin} 的 a1 缺失或无法解密`);
    }

    const { a1: _a1, a1Ref: _a1Ref, group: _group, ...rest } = raw;
    return { ...rest, group, a1: new Uint8Array(Buffer.from(encoded, 'base64')) };
  }

  async put(account: StoredAccount): Promise<void> {
    assertUin(account.uin);
    assertGroup(account.group);
    await mkdir(this.dir, { recursive: true, mode: DIR_MODE });

    const secret = Buffer.from(account.a1).toString('base64');
    const { a1: _a1, ...rest } = account;
    let payload: DiskAccount;

    if (this.secrets) {
      const ref = `${SECRET_PREFIX}${account.group}:${account.uin}`;
      await this.secrets.set(ref, secret);
      payload = { ...rest, a1Ref: ref };
    } else {
      payload = { ...rest, a1: secret };
    }

    const envelope: DiskEnvelope = { version: 1, account: payload };
    const target = this.pathOf(account.uin, account.group);
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(envelope, null, 2)}\n`, { mode: FILE_MODE });
    await rename(tmp, target);
    await chmod(target, FILE_MODE);

    // 旧布局的同一条不再有意义：留着会让 list() 出现两条同组同 uin 的记录。
    await this.dropLegacy(account.uin, account.group);
  }

  async delete(uin: string, group: AccountGroup = 'self'): Promise<void> {
    assertUin(uin);
    assertGroup(group);

    const target = this.pathOf(uin, group);
    const raw = await this.readAccountFile(target);
    if (raw) {
      if (raw.a1Ref) await this.secrets?.delete(raw.a1Ref);
      await rm(target, { force: true });
    }
    await this.dropLegacy(uin, group);
  }

  /** 旧文件名里这个 uin 属于哪一组；文件不存在返回 undefined。 */
  private async groupOfLegacy(uin: string): Promise<AccountGroup | undefined> {
    const raw = await this.readAccountFile(this.legacyPathOf(uin));
    return raw ? inferGroup(raw) : undefined;
  }

  /** 删掉旧布局里属于这一组的凭据（组不符时不动，那是另一组的）。 */
  private async dropLegacy(uin: string, group: AccountGroup): Promise<void> {
    const legacy = this.legacyPathOf(uin);
    let raw: DiskAccount | undefined;
    try {
      raw = await this.readAccountFile(legacy);
    } catch (cause) {
      // 旧文件坏了不该让 put/delete 失败：它已经不影响新布局。
      void cause;
      return;
    }
    if (!raw || inferGroup(raw) !== group) return;
    if (raw.a1Ref) await this.secrets?.delete(raw.a1Ref);
    await rm(legacy, { force: true });
  }

  private async readAccountFile(path: string): Promise<DiskAccount | undefined> {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (cause) {
      if (isMissing(cause)) return undefined;
      throw cause;
    }

    let envelope: DiskEnvelope;
    try {
      envelope = JSON.parse(text) as DiskEnvelope;
    } catch (cause) {
      throw new WeqBotError('CREDENTIAL_CORRUPT', `${path} 的凭据不是合法 JSON`, { cause });
    }
    if (envelope.version !== 1 || !envelope.account) {
      throw new WeqBotError('CREDENTIAL_CORRUPT', `${path} 的凭据版本不受支持`);
    }
    return envelope.account;
  }

  private pathOf(uin: string, group: AccountGroup): string {
    return join(this.dir, `${group}-${uin}.json`);
  }

  private legacyPathOf(uin: string): string {
    return join(this.dir, `${uin}.json`);
  }
}

/** 旧文件没有 `group`：`login-db` 来的归本机组，其余（扫码 / 宿主交付）归自主组。 */
function inferGroup(raw: DiskAccount): AccountGroup {
  if (raw.group === 'local' || raw.group === 'self') return raw.group;
  return raw.a1Origin === 'login-db' ? 'local' : 'self';
}

function assertUin(uin: string): void {
  if (!/^\d{5,12}$/.test(uin)) {
    throw new WeqBotError('UNKNOWN', `非法 uin：${JSON.stringify(uin)}`);
  }
}

function assertGroup(group: string): void {
  if (!GROUPS.includes(group as AccountGroup)) {
    throw new WeqBotError('UNKNOWN', `非法账号分组：${JSON.stringify(group)}`);
  }
}

function isMissing(cause: unknown): boolean {
  return (
    typeof cause === 'object' && cause !== null && (cause as { code?: string }).code === 'ENOENT'
  );
}
