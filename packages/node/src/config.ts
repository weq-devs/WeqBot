/**
 * `--config <path>` 的加载与校验。
 *
 * 设计约束：
 *
 * 1. **配置里不能有 a1**。凭据只走 `CredentialVault`；把 a1 写进 JSON 是最常见的
 *    泄漏路径，所以这里遇到 `a1` / `d1` 之类的键会**直接报错**，而不是静默忽略。
 * 2. **失败的字段要说清楚是哪一项**。这份文件是用户手写的，出错时只说
 *    「配置无效」等于没写。
 * 3. 不认识的顶层键也报错 —— 拼错的键（`oneBot` vs `onebot`）静默失效比报错更糟。
 *
 * 形状与 `BotConfig` 一致（少 `account`，那份由 `--account` 决定）。
 */

import { readFile } from 'node:fs/promises';
import type { BotConfig } from '@weqbot/bot';

/** 允许出现在配置文件里的顶层键。`account` 不在其中：账号只由 `--account` 给。 */
const ALLOWED_KEYS = new Set([
  'native',
  'qq',
  'session',
  'secToken',
  'onebot',
  'log',
  'keepRaw',
  'maxReloginAttempts',
]);

/** 一旦出现就说明有人在往配置文件里塞凭据。 */
const FORBIDDEN_KEYS = new Set(['a1', 'd1', 'a2', 'd2', 'd2Key', 'd2key', 'uid', 'guid']);

export class ConfigError extends Error {
  constructor(path: string, detail: string) {
    super(`配置文件 ${path} 无效：${detail}`);
    this.name = 'ConfigError';
  }
}

export type LoadedConfig = Omit<BotConfig, 'account'>;

/**
 * 读一份 JSON 配置。
 *
 * 只做「形状 + 明显错误」的检查；深层的业务校验交给 `createBot`（它已经在
 * 启动时逐项校验，重复一遍只会让两边漂移）。
 */
export async function loadConfigFile(path: string): Promise<LoadedConfig> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    throw new ConfigError(path, `读不到文件（${(cause as NodeJS.ErrnoException).code ?? cause}）`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new ConfigError(path, `不是合法 JSON（${(cause as Error).message}）`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(path, '顶层必须是对象');
  }

  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new ConfigError(
        path,
        `不允许出现 "${key}"：凭据只能通过 CredentialVault 交付，不要写进配置文件`,
      );
    }
    if (!ALLOWED_KEYS.has(key)) {
      throw new ConfigError(path, `不认识的键 "${key}"（可用：${[...ALLOWED_KEYS].join(' / ')}）`);
    }
  }

  // `onebot` 是最常被写错的一块（少个 networks、networks 里少一类）。
  if (record.onebot !== undefined) validateOneBot(path, record.onebot);

  return record as LoadedConfig;
}

function validateOneBot(path: string, value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(path, 'onebot 必须是对象');
  }
  const networks = (value as Record<string, unknown>).networks;
  if (networks === undefined) {
    throw new ConfigError(path, 'onebot.networks 缺失（即使不监听也要写空数组）');
  }
  if (typeof networks !== 'object' || networks === null || Array.isArray(networks)) {
    throw new ConfigError(path, 'onebot.networks 必须是对象');
  }
  const required = ['httpServers', 'httpClients', 'wsServers', 'wsClients'] as const;
  for (const key of required) {
    const list = (networks as Record<string, unknown>)[key];
    if (!Array.isArray(list)) {
      throw new ConfigError(path, `onebot.networks.${key} 必须是数组（没有就写 []）`);
    }
  }
}

/**
 * 把 `--config` 的产物和命令行覆盖项合并。
 *
 * 命令行优先：`--qq-db` 覆盖配置文件里的 `qq.dbPath`，`--account` 永远是账号来源。
 */
export function mergeConfig(options: {
  file?: LoadedConfig;
  uin: string;
  qqDbPath?: string;
}): BotConfig {
  const file = options.file ?? {};
  const qqDbPath = options.qqDbPath ?? file.qq?.dbPath;
  return {
    ...file,
    account: { uin: options.uin },
    ...(qqDbPath ? { qq: { ...file.qq, dbPath: qqDbPath } } : {}),
  };
}
