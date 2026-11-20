/**
 * QQ 安装 / 数据目录的**纯路径探测**（W4）。
 *
 * 搬运自 WeQ `packages/platform/src/{linux,win32,darwin}/paths.ts`（2026-11-16），
 * 只保留登录页需要的部分：数据根、`login.db`、QQ 可执行文件、`wrapper.node`、
 * `major.node`、`package.json`（客户端版本）。
 *
 * **本文件只做「在已知候选里挑存在的那个」**，不起进程、不读内存。
 * 需要起子进程的探测（Windows 注册表 / 协议处理器、macOS Spotlight）在
 * `qq-detect.ts` 里，结果以 {@link QqHints} 传进来。
 *
 * 覆盖来源与优先级（高 → 低）：
 *
 * | 侧 | 来源 |
 * | --- | --- |
 * | 数据根 | 配置文件 / 设置页 → `WEQBOT_QQ_ROOT` → 平台默认 |
 * | 安装根 | 配置文件 / 设置页 → `WEQBOT_QQ_INSTALL_DIR` → `WEQBOT_QQ_EXE` → 平台探测 |
 *
 * 只有「安装根」可以从 `WEQBOT_QQ_EXE` 反推；**数据根只认 `WEQBOT_QQ_ROOT`** ——
 * 这两者在 QQ 的布局里没有固定关系（Windows 上可以分别在 C: 和 D:）。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import type { VerifyFileOptions } from '@weqbot/wire';
import type { QqHints } from './qq-detect';
import { normalizeQqDataRoot, normalizeQqInstallDir } from './qq-normalize';

export interface QqPaths {
  /** 探测目标平台（覆盖 / 测试时可与宿主不同）。 */
  platform: NodeJS.Platform;
  /** 数据根（Linux `~/.config/QQ`、macOS 容器、Windows `…\Tencent Files`）。 */
  dataRoot: string | null;
  /** 所有 `login.db`，按优先级排序（primary 先于 supplementary，见 `loginDbsOf`）。 */
  loginDbs: string[];
  /** QQ 可执行文件。 */
  qqExe: string | null;
  /** 安装根：Linux 含 `qq` 的目录、macOS 的 `QQ.app`、Windows 含 `QQ.exe` 的目录。 */
  installRoot: string | null;
  /** `<安装根>/…/resources/app`：`wrapper.node` / `major.node` / `package.json` 都在这。 */
  appDir: string | null;
  /** `wrapper.node`（mode 2 签名必需）。 */
  wrapperNode: string | null;
  /** `major.node`（appid / qua / version 锚点）。 */
  majorNode: string | null;
  /** `resources/app/package.json` 里的客户端版本（如 `3.2.35-54395`）。 */
  version: string | null;
  /** 每一项是怎么来的，设置页用来显示「手动 / 环境变量 / 自动」。 */
  sources: {
    dataRoot?: 'override' | 'env' | 'detected';
    qqExe?: 'override' | 'env' | 'protocol' | 'registry' | 'spotlight' | 'detected';
  };
}

export interface QqPathOverrides {
  /** 安装根（用户在设置页 / 配置文件里填的）。 */
  installDir?: string | null;
  /** 数据根（同上）。 */
  dataDir?: string | null;
  /** QQ 可执行文件；给了就不用再找安装根。 */
  exe?: string | null;
}

export interface DiscoverQqPathsOptions {
  platform?: NodeJS.Platform;
  home?: string;
  /** 默认 `process.env`；测试可传一份假环境。 */
  env?: NodeJS.ProcessEnv;
  /** 优先级最高的覆盖（配置文件 / 设置页）。 */
  overrides?: QqPathOverrides;
  /** 由 `detectQqHints` / `ensureQqHints` 得到；不给则只做静态探测。 */
  hints?: QqHints;
  /**
   * 拼路径用哪种方言；默认跟随 `platform`。
   *
   * 只有「在 Linux / macOS 上模拟 Windows 布局」的测试需要把它设成 `posix` ——
   * 真实运行时 `platform === 'win32'` 就等价于宿主方言。
   */
  pathStyle?: 'win32' | 'posix';
}

/**
 * 探测本机 QQ 的安装与数据目录。
 *
 * 两种调用形态都支持：
 *
 * ```ts
 * discoverQqPaths({ platform: 'win32', overrides: { installDir }, hints });
 * discoverQqPaths('linux', '/home/me');   // 旧签名（测试与嵌入方在用）
 * ```
 */
export function discoverQqPaths(options?: DiscoverQqPathsOptions): QqPaths;
export function discoverQqPaths(platform?: NodeJS.Platform, home?: string): QqPaths;
export function discoverQqPaths(
  optionsOrPlatform?: DiscoverQqPathsOptions | NodeJS.Platform,
  home?: string,
): QqPaths {
  const legacy = typeof optionsOrPlatform === 'string' || optionsOrPlatform === undefined;
  const options: DiscoverQqPathsOptions = legacy
    ? {
        ...(optionsOrPlatform ? { platform: optionsOrPlatform } : {}),
        ...(home ? { home } : {}),
        // 旧签名用的是宿主 `node:path`，在 Linux 上模拟 Windows 布局时得到的是
        // POSIX 字符串；保持这个行为，否则老调用方（含既有测试）会全部错位。
        pathStyle: process.platform === 'win32' ? 'win32' : 'posix',
      }
    : optionsOrPlatform;

  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDir = options.home ?? homedir();
  // `platform` 决定「找哪些位置」，`pathStyle` 决定「怎么拼字符串」。两者分开
  // 才能在一台 Linux 机器上模拟 Windows 布局（测试就是靠这个）。
  const pathStyle = options.pathStyle ?? (platform === 'win32' ? 'win32' : 'posix');
  const dialect = pathStyle === 'win32' ? win32 : posix;
  // 归一化必须与方言一致：在 Linux 上模拟 Windows 布局时，路径串是 POSIX 形态，
  // 用 win32 语义去 `dirname` 会把 `/tmp/x/QQ` 变成 `\tmp\x`。
  const normalizePlatform: NodeJS.Platform = pathStyle === 'win32' ? 'win32' : 'linux';
  const layout = layoutFor(platform, dialect);
  const overrides = options.overrides ?? {};
  const hints = options.hints;

  // ── 数据根 ──
  const dataRoots: Array<{ path: string; source: 'override' | 'env' | 'detected' }> = [];
  const pushDataRoot = (
    value: string | null | undefined,
    source: 'override' | 'env' | 'detected',
  ) => {
    if (!value) return;
    const normalized = normalizeQqDataRoot(value, normalizePlatform);
    if (!dataRoots.some((item) => item.path === normalized)) {
      dataRoots.push({ path: normalized, source });
    }
  };
  pushDataRoot(overrides.dataDir, 'override');
  pushDataRoot(env.WEQBOT_QQ_ROOT, 'env');
  for (const candidate of layout.dataRootCandidates(homeDir, env))
    pushDataRoot(candidate, 'detected');

  const dataRootHit = dataRoots.find((item) => existsSync(item.path));
  const dataRoot = dataRootHit?.path ?? null;
  const dataRootsOnDisk = dataRoots.map((item) => item.path);

  // ── login.db（segment-major，对齐 WeQ）──
  const loginDbs = loginDbsOf(dataRootsOnDisk, platform, dialect);

  // ── 安装侧 ──
  const install = resolveInstall({
    platform,
    layout,
    dialect,
    normalizePlatform,
    overrides,
    env,
    hints,
    home: homeDir,
  });

  return {
    platform,
    dataRoot,
    loginDbs,
    qqExe: install.qqExe,
    installRoot: install.installRoot,
    appDir: install.appDir,
    wrapperNode: install.appDir
      ? firstExisting([dialect.join(install.appDir, 'wrapper.node')])
      : null,
    majorNode: install.appDir ? firstExisting([dialect.join(install.appDir, 'major.node')]) : null,
    version: install.appDir ? readQqVersion(install.appDir, dialect) : null,

    sources: {
      ...(dataRootHit ? { dataRoot: dataRootHit.source } : {}),
      ...(install.qqExe && install.qqExeSource ? { qqExe: install.qqExeSource } : {}),
    },
  };
}

// ─────────────────────────── 平台布局 ───────────────────────────

interface Layout {
  /** 数据根候选（未做存在性过滤）。 */
  dataRootCandidates(home: string, env: NodeJS.ProcessEnv): string[];
  /** 安装根 → `resources/app`。 */
  appDirFromRoot(root: string): string;
  /** `resources/app` → 安装根。 */
  rootFromAppDir(appDir: string): string;
  /** 可执行文件 → 安装根。 */
  rootFromExe(exe: string): string;
  /** 安装根 → 可执行文件。 */
  exeFromRoot(root: string): string;
  /** 静态可执行文件候选。 */
  exeCandidates(home: string): string[];
}

/**
 * `platform` 选布局，`path` 选拼字符串的方言。
 *
 * 真实运行时两者一致（宿主就是目标平台）；只有在 Linux 上模拟 Windows 布局的测试里
 * 才会出现 `platform: 'win32'` + `path: posix`。
 */
function layoutFor(platform: NodeJS.Platform, path: typeof posix): Layout {
  if (platform === 'win32') {
    return {
      dataRootCandidates: (home) => win32DataRootCandidates(home, path),
      // Windows 的 app 目录其实在 `versions/<cur>/` 下面；这里只给扁平形态，
      // 真正的版本目录解析由 `appDirOf` 里的 `resolveQqVersionDir` 完成。
      appDirFromRoot: (root) => path.join(root, 'resources', 'app'),
      rootFromAppDir: (appDir) => path.resolve(appDir, '..', '..', '..', '..'),
      rootFromExe: (exe) => path.dirname(exe),
      exeFromRoot: (root) => path.join(root, 'QQ.exe'),
      exeCandidates: () => [],
    };
  }
  if (platform === 'darwin') {
    return {
      dataRootCandidates: (home) => [
        path.join(
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
      appDirFromRoot: (root) => path.join(root, 'Contents', 'Resources', 'app'),
      rootFromAppDir: (appDir) => path.resolve(appDir, '..', '..', '..'),
      rootFromExe: (exe) => path.resolve(exe, '..', '..', '..'),
      exeFromRoot: (root) => path.join(root, 'Contents', 'MacOS', 'QQ'),
      exeCandidates: (home) => [
        '/Applications/QQ.app/Contents/MacOS/QQ',
        path.join(home, 'Applications', 'QQ.app', 'Contents', 'MacOS', 'QQ'),
      ],
    };
  }
  return {
    dataRootCandidates: (home, env) => [path.join(xdgConfig(home, env), 'QQ')],
    appDirFromRoot: (root) => path.join(root, 'resources', 'app'),
    rootFromAppDir: (appDir) => path.resolve(appDir, '..', '..'),
    rootFromExe: (exe) => path.dirname(exe),
    exeFromRoot: (root) => path.join(root, 'qq'),
    exeCandidates: (home) => [
      '/opt/QQ/qq',
      '/usr/share/QQ/qq',
      '/usr/lib/QQ/qq',
      path.join(home, 'NapCat', 'opt', 'QQ', 'qq'),
      path.join(home, 'Napcat', 'opt', 'QQ', 'qq'),
    ],
  };
}

function xdgConfig(home: string, env: NodeJS.ProcessEnv): string {
  const xdg = env.XDG_CONFIG_HOME;
  return xdg && xdg.length > 0 ? xdg : posix.join(home, '.config');
}

// ─────────────────────────── 安装侧解析 ───────────────────────────

interface InstallResult {
  installRoot: string | null;
  appDir: string | null;
  qqExe: string | null;
  qqExeSource?: QqPaths['sources']['qqExe'];
}

function resolveInstall(input: {
  platform: NodeJS.Platform;
  layout: Layout;
  dialect: typeof posix;
  /** 归一化用的平台（与 `dialect` 对应）。 */
  normalizePlatform: NodeJS.Platform;
  overrides: QqPathOverrides;
  env: NodeJS.ProcessEnv;
  hints?: QqHints;
  home: string;
}): InstallResult {
  const { platform, layout, dialect, normalizePlatform, overrides, env, hints, home } = input;
  const settle = (root: string, source: NonNullable<QqPaths['sources']['qqExe']>) =>
    installFromRoot(root, source, platform, dialect);

  // 1. 显式安装根（配置 / 设置页）。
  const overrideRoot = overrides.installDir
    ? normalizeQqInstallDir(overrides.installDir, normalizePlatform)
    : null;
  if (overrideRoot && existsSync(overrideRoot)) return settle(overrideRoot, 'override');

  // 2. 环境变量安装根。
  const envRoot = env.WEQBOT_QQ_INSTALL_DIR
    ? normalizeQqInstallDir(env.WEQBOT_QQ_INSTALL_DIR, normalizePlatform)
    : null;
  if (envRoot && existsSync(envRoot)) return settle(envRoot, 'env');

  // 3. 显式可执行文件：用户填的可能是文件，也可能直接就是目录。
  const exeOverride = overrides.exe ?? env.WEQBOT_QQ_EXE ?? null;
  if (exeOverride) {
    const root =
      existsSync(exeOverride) && isFile(exeOverride)
        ? layout.rootFromExe(exeOverride)
        : normalizeQqInstallDir(exeOverride, normalizePlatform);
    if (root && existsSync(root)) return settle(root, 'override');
  }

  // 4. 平台探测结果：Windows 协议处理器优先，注册表兜底（对齐 WeQ）。
  if (platform === 'win32') {
    if (hints?.protocolExe && existsSync(hints.protocolExe)) {
      const appDir = dialect.dirname(hints.protocolExe);
      const root = layout.rootFromAppDir(appDir);
      const resolved = installFromAppDir(root, appDir, 'protocol', platform, dialect);
      if (resolved.appDir || resolved.qqExe) return resolved;
    }
    if (hints?.installDir && existsSync(hints.installDir)) {
      const resolved = settle(hints.installDir, 'registry');
      if (resolved.qqExe || resolved.appDir) return resolved;
    }
  }
  if (platform === 'darwin' && hints?.spotlightApp && existsSync(hints.spotlightApp)) {
    return settle(normalizeQqInstallDir(hints.spotlightApp, normalizePlatform), 'spotlight');
  }

  // 5. 静态候选（Linux / macOS 标准安装位置）。
  for (const candidate of layout.exeCandidates(home)) {
    if (!existsSync(candidate)) continue;
    return settle(layout.rootFromExe(candidate), 'detected');
  }

  return { installRoot: null, appDir: null, qqExe: null };
}

/** 从安装根推导 app 目录（Windows 要过一遍 `versions/<cur>`）。 */
function appDirOf(
  root: string,
  platform: NodeJS.Platform,
  layout: Layout,
  dialect: typeof posix,
): string | null {
  if (platform === 'win32') {
    const versionDir = resolveQqVersionDir(root, dialect);
    if (versionDir) {
      const candidate = dialect.join(versionDir, 'resources', 'app');
      if (existsSync(candidate)) return candidate;
    }
    // 没 `versions/` 的便携版：退回扁平布局，比直接放弃有用。
    const flat = dialect.join(root, 'resources', 'app');
    return existsSync(flat) ? flat : null;
  }
  const candidate = layout.appDirFromRoot(root);
  return existsSync(candidate) ? candidate : null;
}

function installFromRoot(
  root: string,
  source: NonNullable<QqPaths['sources']['qqExe']>,
  platform: NodeJS.Platform,
  dialect: typeof posix,
): InstallResult {
  const appDir = appDirOf(root, platform, layoutFor(platform, dialect), dialect);
  return installFromAppDir(root, appDir, source, platform, dialect);
}

function installFromAppDir(
  root: string,
  appDir: string | null,
  source: NonNullable<QqPaths['sources']['qqExe']>,
  platform: NodeJS.Platform,
  dialect: typeof posix,
): InstallResult {
  const exeCandidate = layoutFor(platform, dialect).exeFromRoot(root);
  const qqExe = existsSync(exeCandidate) ? exeCandidate : null;
  return {
    installRoot: root,
    appDir,
    qqExe,
    ...(qqExe ? { qqExeSource: source } : {}),
  };
}

// ─────────────────────────── login.db ───────────────────────────

/**
 * 所有 `login.db`，按合并优先级排序。
 *
 * **segment-major**（与 WeQ `linux/paths.ts:154-168` 一致）：先在所有根里找
 * `<root>/global/nt_db/login.db`，再找旧布局 `<root>/nt_qq/global/nt_db/login.db`。
 * 多根机器上这保证「primary 永远排在 supplementary 前面」——
 * 调用方 `dedupeByUin` 保留先到者，所以 primary 的账号行会赢。
 */
function loginDbsOf(
  roots: readonly string[],
  platform: NodeJS.Platform,
  path: typeof posix,
): string[] {
  const segmentsList =
    platform === 'win32'
      ? // Windows 只有一处。
        [['nt_qq', 'global', 'nt_db', 'login.db']]
      : [
          ['global', 'nt_db', 'login.db'],
          ['nt_qq', 'global', 'nt_db', 'login.db'],
        ];

  const out: string[] = [];
  for (const segments of segmentsList) {
    for (const root of roots) {
      const candidate = path.join(root, ...segments);
      if (existsSync(candidate) && !out.includes(candidate)) out.push(candidate);
    }
  }
  return out;
}

// ─────────────────────────── Windows 专属 ───────────────────────────

/**
 * Windows 数据根候选，按 QQ 实际认的顺序排列。
 *
 * `UserDataSavePathType` 决定 QQ 真正用哪个目录：`2` 才认 `UserDataSavePath`，
 * `1` 是 `Documents/Tencent Files`，其余取值（0、3、未知、字段缺失）是旧版
 * 布局 `Documents/QQ`。只有 type=2 时 savePath 才排第一；其它情况下 QQ 会忽略
 * 它，但用户手工改 ini 指回旧数据的情况真实存在，所以仍留作降级候选。
 */
function win32DataRootCandidates(home: string, path: typeof posix): string[] {
  const roots: string[] = [];
  const info = readUserDataInfo(home, path);
  const savePath = info?.savePath ?? null;
  const savePathType = info?.savePathType ?? null;
  if (savePathType === 2 && savePath) roots.push(savePath);
  roots.push(
    savePathType === 1
      ? path.join(home, 'Documents', 'Tencent Files')
      : path.join(home, 'Documents', 'QQ'),
  );
  if (savePathType !== 2 && savePath) roots.push(savePath);
  roots.push(path.join(home, 'Tencent Files'));
  try {
    for (const entry of readdirSync(home)) {
      if (!entry.toLowerCase().startsWith('admin')) continue;
      roots.push(
        path.join(home, entry, 'Documents', 'Tencent Files'),
        path.join(home, entry, 'Documents', 'QQ'),
      );
    }
  } catch {
    // home 不可读：只用静态候选。
  }
  return roots;
}

/**
 * `versions/` 下的当前版本目录。
 *
 * 对齐 WeQ `win32/paths.ts:428-463`：**先数子目录** —— 只有一个就直接用它（不读
 * `config.json`，避免配置写坏时反而找不到）；多个才读 `config.json` 并校验
 * `curVersion` 确实是其中一个子目录。
 */
export function resolveQqVersionDir(qqRoot: string, path: typeof posix = win32): string | null {
  const versions = path.join(qqRoot, 'versions');
  let subdirs: string[];
  try {
    subdirs = readdirSync(versions).filter((entry) => {
      try {
        return statSync(path.join(versions, entry)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return null;
  }

  if (subdirs.length === 0) return null;
  if (subdirs.length === 1) {
    const only = subdirs[0];
    return only ? path.join(versions, only) : null;
  }

  try {
    const config = JSON.parse(readFileSync(path.join(versions, 'config.json'), 'utf8')) as {
      curVersion?: unknown;
    };
    const current = config.curVersion;
    if (typeof current === 'string' && subdirs.includes(current)) {
      return path.join(versions, current);
    }
  } catch {
    // 没有 config.json 或它坏了：无法在多个版本里选，交给上层放弃。
  }
  return null;
}

/** `[UserDataSet]` 里与数据根有关的两项。 */
export interface UserDataInfo {
  /**
   * `UserDataSavePathType`：`2` 才认 `UserDataSavePath`，`1` 是
   * `Documents/Tencent Files`，其余取值（0、3、未知、字段缺失）是旧版
   * 布局 `Documents/QQ`。
   */
  savePathType: number | null;
  /** `UserDataSavePath` 原始值（未判断 type）；缺失或为空时 null。 */
  savePath: string | null;
}

/**
 * 读 `%PUBLIC%\Documents\Tencent\QQ\UserDataInfo.ini`（即 home 同级的
 * `Public`）。ini 缺失 / 读不了时返回 null；只认 `[UserDataSet]` 段。
 */
export function readUserDataInfo(home: string, path: typeof posix = win32): UserDataInfo | null {
  const ini = path.join(
    path.dirname(home),
    'Public',
    'Documents',
    'Tencent',
    'QQ',
    'UserDataInfo.ini',
  );
  let text: string;
  try {
    text = readFileSync(ini, 'utf8');
  } catch {
    return null;
  }
  const info: UserDataInfo = { savePathType: null, savePath: null };
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
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    if (key === 'userdatasavepath') {
      info.savePath = value.length > 0 ? value : null;
    } else if (key === 'userdatasavepathtype') {
      info.savePathType = /^-?\d+$/.test(value) ? Number(value) : null;
    }
  }
  return info;
}

// ─────────────────────────── 小工具 ───────────────────────────

/**
 * 读 `resources/app/package.json` 的 `version`（如 `3.2.35-54395`）。
 *
 * 这是**与 native `resolveAppidFromMajor` 并行的第二条版本来源**：native 解析
 * `major.node` 失败时（文件被裁、构建异常），设置页至少还能显示版本号。
 */
export function readQqVersion(appDir: string | null, path: typeof posix = posix): string | null {
  if (!appDir) return null;
  try {
    const parsed = JSON.parse(readFileSync(path.join(appDir, 'package.json'), 'utf8')) as {
      version?: unknown;
    };
    return typeof parsed.version === 'string' && parsed.version.length > 0 ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * 由探测结果拼 `verify_file`（`trpc.o3.report.Report.SsoReport`）的上报参数。
 *
 * 三端共用同一套形状，只换安装根：Windows 的 app 目录在
 * `<root>/versions/<cur>/resources/app`，macOS 在 `QQ.app/Contents/Resources/app`，
 * Linux 是 `/opt/QQ/resources/app` —— 这些差异 `discoverQqPaths` 已经抹平
 * （`appDir` 就是 `<…>/resources/app`），这里只做字符串拼接与存在性标记。
 *
 * **探不到就不猜**：没有 `appDir` 时返回 undefined，让 native 按平台默认；
 * 半份路径比默认值更容易与服务端的形态比对不一致。
 */
export function verifyFileOptionsFor(paths: QqPaths): VerifyFileOptions | undefined {
  const { appDir, qqExe } = paths;
  if (!appDir) return undefined;

  // 拼路径要用与探测时相同的方言。不按 `paths.platform` 判，而是看 `appDir`
  // 本身：测试 / 交叉检查会在 Linux 上用 POSIX 串模拟 Windows 布局
  // （`discoverQqPaths({ platform: 'win32', pathStyle: 'posix' })`），
  // 真机 Windows 的 `appDir` 则是反斜杠串 —— 以探测结果为准最不容易错。
  const dialect = appDir.includes('\\') ? win32 : posix;
  const app = (...parts: string[]) => dialect.join(appDir, ...parts);
  // 抓包里 13 条路径的顺序，与 native 的默认清单一致；只换安装根。
  const candidates = [
    app('app_launcher', 'index.js'),
    app('app_launcher', 'launcher.js'),
    app('application.asar', '165.background.js'),
    app('application.asar', '288.background.js'),
    app('application.asar', '357.background.js'),
    app('application.asar', '571.background.js'),
    app('application.asar', '790.background.js'),
    app('application.asar', '86.background.js'),
    app('application.asar', '875.background.js'),
    app('application.asar', 'app_launcher', 'index.js'),
    app('application.asar', 'app_launcher', 'launcher.js'),
    app('application.asar', 'background.js'),
    app('application.asar', 'node-plugin.background.js'),
  ];
  // 四类受检文件：顺序固定 application.asar / major.node / package.json / wrapper.node。
  // 与 native 一致按**路径存在**判断 —— QQ 的 `application.asar` 本身就是个目录，
  // 只认常规文件会把抓包里的 `"1"` 判成 `"0"`。
  const fileMarks = ['application.asar', 'major.node', 'package.json', 'wrapper.node'].map(
    (name) => (existsSync(app(name)) ? '1' : '0'),
  );

  return {
    paths: candidates,
    fileMarks,
    // `qqExe` 探到了才给：探不到时 native 按平台默认，比编一个路径老实。
    ...(qqExe ? { binaryPath: qqExe } : {}),
  };
}

function firstExisting(candidates: string[]): string | null {
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return null;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** `login.db` 的固定 pre-login key（页 HMAC / KDF 参数由 native probe 给出）。 */
export const LOGIN_DB_KEY = 'BD156D6710D54D8782F4';
