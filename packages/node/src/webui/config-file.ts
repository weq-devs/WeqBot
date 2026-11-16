/**
 * 把 WebUI 的网络页保存回 `--config` 文件。
 *
 * 口径：OneBot 配置按账号隔离，写进顶层 `onebotByUin[uin]`。其余键原样保留
 * （`native` / `qq` / `session` / `log` … 都是用户手写的，重写一遍容易丢东西，
 * 也没必要）。写盘是「读 → 改 → 原子替换」：先写 `.tmp` 再 `rename`，断电不会
 * 留下半个 JSON。
 */

import { readFile, rename, writeFile } from 'node:fs/promises';
import type { BotOneBotConfig } from '@weqbot/bot';

export class ConfigSaveError extends Error {
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(`保存配置到 ${path} 失败：${detail}`);
    this.name = 'ConfigSaveError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 读一份配置；文件不存在当作空对象（第一次配置就是这种状态）。 */
async function readConfigObject(path: string): Promise<Record<string, unknown>> {
  try {
    const text = await readFile(path, 'utf8');
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw new ConfigSaveError(path, cause instanceof Error ? cause.message : String(cause));
    }
    return {};
  }
}

/** 原子写：`.tmp` + `rename`，断电不会留下半个 JSON。 */
async function writeConfigObject(path: string, value: Record<string, unknown>): Promise<void> {
  const next = `${JSON.stringify(value, null, 2)}\n`;
  const temp = `${path}.tmp`;
  try {
    await writeFile(temp, next, { mode: 0o600 });
    await rename(temp, path);
  } catch (cause) {
    throw new ConfigSaveError(path, cause instanceof Error ? cause.message : String(cause));
  }
}

/** 用户在设置页手动指定的 QQ 路径；`null` 表示清除该项、回到自动探测。 */
export interface QqPathsPatch {
  installDir?: string | null;
  dataDir?: string | null;
}

/**
 * 把设置页的 QQ 路径写回 `--config`。
 *
 * 只动 `qq.installDir` / `qq.dataDir` 两个键：`null` 删键、其余顶层键与
 * `qq.dbPath` 原样保留。`qq` 变空就整个删掉，避免留下 `"qq": {}` 这种噪声。
 */
export async function saveQqPaths(path: string, patch: QqPathsPatch): Promise<void> {
  const current = await readConfigObject(path);
  const qq = isRecord(current.qq) ? { ...current.qq } : {};

  for (const key of ['installDir', 'dataDir'] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null) delete qq[key];
    else qq[key] = value;
  }

  const next: Record<string, unknown> = { ...current };
  if (Object.keys(qq).length > 0) next.qq = qq;
  else delete next.qq;

  await writeConfigObject(path, next);
}

export async function saveOneBotConfig(
  path: string,
  uin: string,
  config: BotOneBotConfig,
): Promise<void> {
  const current = await readConfigObject(path);
  const previousMap = isRecord(current.onebotByUin) ? current.onebotByUin : {};
  const nextMap = { ...previousMap, [uin]: config };
  // 旧格式的全局 `onebot` 已不再被加载器接受，保存时顺手清掉，避免写出一份
  // 自己都读不回来的配置。
  const { onebot: _legacyOneBot, ...rest } = current;
  void _legacyOneBot;
  await writeConfigObject(path, { ...rest, onebotByUin: nextMap });
}
