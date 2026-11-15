/**
 * QQ 安装 / 数据目录的**纯路径探测**（W4）。
 *
 * 搬运自 WeQ `packages/platform/src/{linux,win32,darwin}/paths.ts`（2026-11-16），
 * 只保留登录页需要的部分：数据根、`login.db`、QQ 可执行文件、`wrapper.node`、
 * `major.node`。**都是纯函数**：只读文件系统做 `existsSync`，不起进程、不读内存、
 * 不碰注册表以外的状态（win32 的 `UserDataInfo.ini` 是普通文件）。
 *
 * 与 WeQ 的差异：**不读注册表**。Windows 的协议处理器（`timwp.exe`）定位需要
 * 注册表，这块留给调用方通过 `WEQBOT_QQ_ROOT` 覆盖 —— 登录页会显示「未自动找到
 * QQ 安装目录，请手动指定」，而不是猜一个可能错的路径。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface QqPaths {
  /** 数据根（Linux `~/.config/QQ`、macOS 容器、Windows `…\Tencent Files`）。 */
  dataRoot: string | null;
  /** 所有 `login.db`，按优先级排序。 */
  loginDbs: string[];
  /** QQ 可执行文件。 */
  qqExe: string | null;
  /** `wrapper.node`（mode 2 签名必需）。 */
  wrapperNode: string | null;
  /** `major.node`（appid / qua / version 锚点）。 */
  majorNode: string | null;
}

/**
 * 探测本机 QQ 的安装与数据目录。
 *
 * `overrideRoot` 优先于一切自动探测（用户在设置里手动指定的路径）。环境变量
 * `WEQBOT_QQ_ROOT` / `WEQBOT_QQ_EXE` 作为默认覆盖，便于非标准安装。
 */
export function discoverQqPaths(
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
): QqPaths {
  const overrideRoot = process.env.WEQBOT_QQ_ROOT ?? null;
  const overrideExe = process.env.WEQBOT_QQ_EXE ?? null;

  if (platform === 'win32') return discoverWin32(home, overrideRoot, overrideExe);
  if (platform === 'darwin')
    return discoverUnixLike(home, overrideRoot, overrideExe, {
      roots: [
        join(
          home,
          'Library',
          'Containers',
          'com.tencent.qq',
          'Data',
          'Library',
          'Application Support',
          'QQ',
        ),
      ],
      exeCandidates: [
        '/Applications/QQ.app/Contents/MacOS/QQ',
        join(home, 'Applications', 'QQ.app', 'Contents', 'MacOS', 'QQ'),
      ],
      // macOS 的安装目录是 `.app/Contents`，`resources/app` 在 `Contents/Resources/app`。
      wrapperInRoot: (root) => join(root, 'Contents', 'Resources', 'app', 'wrapper.node'),
      majorInRoot: (root) => join(root, 'Contents', 'Resources', 'app', 'major.node'),
      exeRoot: (exe) => join(exe, '..', '..', '..'),
    });

  return discoverUnixLike(home, overrideRoot, overrideExe, {
    roots: [join(xdgConfig(home), 'QQ')],
    exeCandidates: [
      '/opt/QQ/qq',
      '/usr/share/QQ/qq',
      '/usr/lib/QQ/qq',
      join(home, 'NapCat', 'opt', 'QQ', 'qq'),
      join(home, 'Napcat', 'opt', 'QQ', 'qq'),
    ],
    wrapperInRoot: (root) => join(root, 'resources', 'app', 'wrapper.node'),
    majorInRoot: (root) => join(root, 'resources', 'app', 'major.node'),
    exeRoot: (exe) => join(exe, '..'),
  });
}

function xdgConfig(home: string): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg && xdg.length > 0 ? xdg : join(home, '.config');
}

interface Layout {
  roots: string[];
  exeCandidates: string[];
  /** 从安装根算 `wrapper.node`（macOS 多一层 `Contents`）。 */
  wrapperInRoot(root: string): string;
  majorInRoot(root: string): string;
  /** 从可执行文件算安装根。 */
  exeRoot(exe: string): string;
}

function discoverUnixLike(
  _home: string,
  overrideRoot: string | null,
  overrideExe: string | null,
  layout: Layout,
): QqPaths {
  const dataRoots = [
    ...(overrideRoot && existsSync(overrideRoot) ? [overrideRoot] : []),
    ...layout.roots,
  ];
  const dataRoot = dataRoots.find((root) => existsSync(root)) ?? null;

  // login.db 有两个位置（主 + 兼容旧布局），两边都试。
  const loginDbs: string[] = [];
  for (const root of dataRoots) {
    for (const segments of [
      ['global', 'nt_db', 'login.db'],
      ['nt_qq', 'global', 'nt_db', 'login.db'],
    ]) {
      const candidate = join(root, ...segments);
      if (existsSync(candidate) && !loginDbs.includes(candidate)) loginDbs.push(candidate);
    }
  }

  const qqExe =
    (overrideExe && existsSync(overrideExe) ? overrideExe : null) ??
    layout.exeCandidates.find((candidate) => existsSync(candidate)) ??
    null;

  const installRoot = qqExe ? layout.exeRoot(qqExe) : null;
  const wrapperNode = installRoot ? firstExisting([layout.wrapperInRoot(installRoot)]) : null;
  const majorNode = installRoot ? firstExisting([layout.majorInRoot(installRoot)]) : null;

  return { dataRoot, loginDbs, qqExe, wrapperNode, majorNode };
}

/**
 * Windows：数据根来自 `UserDataInfo.ini`，安装目录只认环境变量覆盖。
 *
 * 注册表定位（协议处理器 / 卸载信息）刻意不搬：它要起 `reg.exe` 或读注册表 hive，
 * 而 `packages/node` 的其它能力都不依赖系统状态。找不到时登录页让用户手填。
 */
function discoverWin32(
  home: string,
  overrideRoot: string | null,
  overrideExe: string | null,
): QqPaths {
  const roots: string[] = [];
  if (overrideRoot && existsSync(overrideRoot)) roots.push(overrideRoot);
  const fromIni = tencentFilesRootFromUserDataInfo(home);
  if (fromIni) roots.push(fromIni);
  roots.push(join(home, 'Documents', 'Tencent Files'), join(home, 'Tencent Files'));
  try {
    for (const entry of readdirSync(home)) {
      if (!entry.toLowerCase().startsWith('admin')) continue;
      roots.push(join(home, entry, 'Documents', 'Tencent Files'));
    }
  } catch {
    // home 不可读：只用静态候选。
  }

  // win32 的 login.db 在 `<root>/nt_qq/global/nt_db/login.db`。
  const loginDbs: string[] = [];
  for (const root of [...new Set(roots)]) {
    const candidate = join(root, 'nt_qq', 'global', 'nt_db', 'login.db');
    if (existsSync(candidate) && !loginDbs.includes(candidate)) loginDbs.push(candidate);
  }
  const dataRoot = roots.find((root) => existsSync(root)) ?? null;

  const qqExe = overrideExe && existsSync(overrideExe) ? overrideExe : null;
  let wrapperNode: string | null = null;
  let majorNode: string | null = null;
  if (qqExe) {
    // `<qqRoot>/versions/<cur>/resources/app/…`；`versions/config.json` 指向当前版本目录。
    const qqRoot = dirname(qqExe);
    const versionDir = resolveQqVersionDir(qqRoot);
    if (versionDir) {
      wrapperNode = firstExisting([join(versionDir, 'resources', 'app', 'wrapper.node')]);
      majorNode = firstExisting([join(versionDir, 'resources', 'app', 'major.node')]);
    }
  }

  return { dataRoot, loginDbs, qqExe, wrapperNode, majorNode };
}

/** `versions/config.json` 里的当前版本目录名。 */
function resolveQqVersionDir(qqRoot: string): string | null {
  const versions = join(qqRoot, 'versions');
  try {
    const config = JSON.parse(readFileSync(join(versions, 'config.json'), 'utf8')) as {
      curVersion?: unknown;
    };
    if (typeof config.curVersion === 'string' && existsSync(join(versions, config.curVersion))) {
      return join(versions, config.curVersion);
    }
  } catch {
    // 没有 config.json：退回「目录里唯一的版本」。
  }
  try {
    const entries = readdirSync(versions, { withFileTypes: true }).filter((entry) =>
      entry.isDirectory(),
    );
    if (entries.length === 1) return join(versions, entries[0]!.name);
  } catch {
    // versions 目录不存在。
  }
  return null;
}

/** `%PUBLIC%\Documents\Tencent\QQ\UserDataInfo.ini` 里的 `UserDataSavePath`。 */
function tencentFilesRootFromUserDataInfo(home: string): string | null {
  const ini = join(dirname(home), 'Public', 'Documents', 'Tencent', 'QQ', 'UserDataInfo.ini');
  let text: string;
  try {
    text = readFileSync(ini, 'utf8');
  } catch {
    return null;
  }
  let inUserDataSet = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[') && line.endsWith(']')) {
      inUserDataSet = line.toLowerCase() === '[userdataset]';
      continue;
    }
    if (!inUserDataSet) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    if (line.slice(0, eq).trim().toLowerCase() !== 'userdatasavepath') continue;
    const value = line.slice(eq + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

function firstExisting(candidates: string[]): string | null {
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return null;
}

/** `login.db` 的固定 pre-login key（页 HMAC / KDF 参数由 native probe 给出）。 */
export const LOGIN_DB_KEY = 'BD156D6710D54D8782F4';
