/**
 * slim native 加载器 —— **整个仓库唯一允许加载 `.node` 的地方**。
 *
 * `scripts/check-pure-ts.mjs` 会强制这一点：其它包出现 `createRequire` / `.node`
 * / `process.dlopen` 一律失败。这条规则是「打包进 WeQ 时是纯 TS」的机器保证，
 * 不靠人记。
 *
 * 查找顺序：
 *   1. 显式 `dir` 参数；
 *   2. `WEQBOT_NATIVE_DIR` 环境变量；
 *   3. `<repo>/native/<platform>-<arch>/`（`pnpm native:fetch` 的落点）。
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NativeBuildInfo, RawNativeBinding } from '@weqbot/wire';

/** slim 产物的文件名；`nt_helper.node` 是 WeQ 那份 full 产物的名字，兼容读取便于本地调试。 */
const CANDIDATES = ['weqbot.node', 'nt_helper.node'] as const;

const here = dirname(fileURLToPath(import.meta.url));

export interface LoadNativeOptions {
  /** 直接指定目录（优先级最高）。 */
  dir?: string;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
}

export interface LoadedNative {
  binding: RawNativeBinding;
  /** 实际加载的文件路径（诊断用）。 */
  path: string;
  buildInfo?: NativeBuildInfo;
  profile: 'full' | 'bot' | 'unknown';
}

export function defaultNativeDir(platform = process.platform, arch = process.arch): string {
  return resolve(here, '..', '..', '..', 'native', `${platform}-${arch}`);
}

export function resolveNativeDir(options: LoadNativeOptions = {}): string {
  const explicit = options.dir ?? process.env.WEQBOT_NATIVE_DIR;
  if (explicit) return resolve(explicit);
  return defaultNativeDir(options.platform, options.arch);
}

export function resolveNativePath(options: LoadNativeOptions = {}): string {
  const dir = resolveNativeDir(options);
  for (const name of CANDIDATES) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `找不到原生组件：${dir} 下没有 ${CANDIDATES.join(' / ')}。` +
      `独立运行时用 \`WEQBOT_NATIVE_DIR\` 指向产物目录。`,
  );
}

/**
 * 加载并做最小自检。
 *
 * 注意：**不校验有效期**。slim 产物按设计不带 30 天时效；full 产物（本地调试时
 * 误指向 WeQ 那份）自带时效，这里只记录不拦截 —— 时效/授权是 WeQ 的发版问题，
 * bot 侧先不考虑（见 TODO「暂不做」）。
 */
export function loadNative(options: LoadNativeOptions = {}): LoadedNative {
  const nativePath = resolveNativePath(options);
  const require = createRequire(import.meta.url);
  const binding = require(nativePath) as RawNativeBinding;

  if (typeof binding.sendPacket !== 'function' || typeof binding.sendOidbPacket !== 'function') {
    throw new Error(`原生组件缺少发包出口：${nativePath}`);
  }

  const buildInfo = typeof binding.getBuildInfo === 'function' ? binding.getBuildInfo() : undefined;

  return {
    binding,
    path: nativePath,
    ...(buildInfo ? { buildInfo } : {}),
    profile: buildInfo?.profile ?? 'unknown',
  };
}
