/**
 * native 加载器 —— **整个仓库唯一允许加载 `.node` 的地方**。
 *
 * `scripts/check-pure-ts.mjs` 会强制这一点：其它包出现 `createRequire` / `.node`
 * / `process.dlopen` 一律失败。这条规则是「打包进 WeQ 时是纯 TS」的机器保证，
 * 不靠人记。
 *
 * 加载的就是 `nt_helper` 的 full 产物（与 WeQ 同一份），WeqBot 不再出 slim 裁剪版。
 *
 * 查找顺序：
 *   1. 显式 `dir` 参数；
 *   2. `WEQBOT_NATIVE_DIR` 环境变量；
 *   3. `<repo>/native/<platform>/<arch>/`（`pnpm native:fetch` 的落点，与 WeQ 同布局）。
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NativeBuildInfo, RawNativeBinding } from '@weqbot/wire';

/** 首选 `nt_helper.node`（`pnpm native:fetch` 的落点名）；`weqbot.node` 兼容旧布局。 */
const CANDIDATES = ['nt_helper.node', 'weqbot.node'] as const;

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

/** 与 `pnpm native:fetch` 的落点、以及 WeQ 的 `native/<platform>/<arch>/` 同布局。 */
export function defaultNativeDir(platform = process.platform, arch = process.arch): string {
  return resolve(here, '..', '..', '..', 'native', platform, arch);
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

/** nt_helper 的 napi `InitStatus`；只在错误文案里用，不参与有效期计算。 */
export const NATIVE_INIT_STATUS = {
  success: 0,
  expired: -1,
  damaged: -200,
  tampered: -201,
} as const;

/**
 * 把 `.node` 自报的初始化状态翻译成加载错误。
 *
 * **天数不在这里算。** 有效期由 nt_helper 的 `common::BUILD_VALIDITY_SECS` 决定，
 * 二进制通过 `getInitStatus()` 给出结论；这里只负责把 -1 翻译成用户能看懂的话。
 * 旧产物没有该导出时跳过，交给具体 API 自己报错。
 */
export function assertNativeInitStatus(status: number | undefined): void {
  if (status === undefined || status === NATIVE_INIT_STATUS.success) return;
  if (status === NATIVE_INIT_STATUS.expired) {
    throw new Error('原生组件已过期，请更新 nt_helper 构建（pnpm native:fetch）');
  }
  if (status === NATIVE_INIT_STATUS.damaged) {
    throw new Error('原生组件安装损坏，请重新安装或更新（pnpm native:fetch）');
  }
  if (status === NATIVE_INIT_STATUS.tampered) {
    throw new Error('原生组件被篡改，请重新安装或更新（pnpm native:fetch）');
  }
  throw new Error(`原生组件初始化失败（getInitStatus()=${status}），请重新安装或更新`);
}

/**
 * 加载并做最小自检。
 *
 * 先看 native 自报的 `getInitStatus()`：过期 / 损坏 / 篡改在加载时给出明确错误，
 * 而不是等到第一次 native 调用才抛出 `Environment validation failed`。
 * 天数只在 nt_helper 的 Rust 里定义一处（`common::BUILD_VALIDITY_SECS`），
 * 这里不计算、也不写死；本地 `cargo` 构建的 `isDev: true` 同样由二进制判定。
 */
export function loadNative(options: LoadNativeOptions = {}): LoadedNative {
  const nativePath = resolveNativePath(options);
  const require = createRequire(import.meta.url);
  const binding = require(nativePath) as RawNativeBinding;

  assertNativeInitStatus(binding.getInitStatus?.());

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
