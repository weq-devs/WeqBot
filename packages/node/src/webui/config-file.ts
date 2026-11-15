/**
 * 把 WebUI 的网络页保存回 `--config` 文件。
 *
 * 口径：**只替换 `onebot` 这一块**，其余键原样保留（`native` / `qq` / `session` /
 * `log` … 都是用户手写的，重写一遍容易丢注释以外的东西，也没必要）。写盘是
 * 「读 → 改 → 原子替换」：先写 `.tmp` 再 `rename`，断电不会留下半个 JSON。
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

export async function saveOneBotConfig(path: string, config: BotOneBotConfig): Promise<void> {
  let current: Record<string, unknown> = {};
  try {
    const text = await readFile(path, 'utf8');
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      current = parsed as Record<string, unknown>;
    }
  } catch (cause) {
    // 文件不存在是正常的（第一次用 WebUI 配置）；读得到但解析不了才是问题。
    const code = (cause as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw new ConfigSaveError(path, cause instanceof Error ? cause.message : String(cause));
    }
  }

  const next = `${JSON.stringify({ ...current, onebot: config }, null, 2)}\n`;
  const temp = `${path}.tmp`;
  try {
    await writeFile(temp, next, { mode: 0o600 });
    await rename(temp, path);
  } catch (cause) {
    throw new ConfigSaveError(path, cause instanceof Error ? cause.message : String(cause));
  }
}
