/**
 * QQ 安装位置的**副作用探测**：Windows 注册表 / 协议处理器、macOS Spotlight。
 *
 * 三端里只有这两端需要起子进程 —— Linux 的候选路径全在磁盘上，`existsSync` 就够。
 *
 * 设计约束：
 *
 * 1. **全 async**。WeQ 的 `win32/registry.ts` 用 `spawnSync`；搬到 WeqBot 后它会
 *    卡在 HTTP 请求线程上（设置页 / 登录页每次探测都要等）。这里统一用
 *    `execFile` + 独立 timeout，让出线程。
 * 2. **解析是纯函数**。`reg` / `mdfind` 的输出格式是本模块唯一难测的部分，
 *    所以把它们剥成 `parseXxx(stdout)`，这样在 Linux / CI 上也能覆盖。
 * 3. **失败一律 null**。`reg` 不存在、键缺失、权限不足、输出畸形、超时 —— 全部
 *    收敛成 null，由上层继续降级，不抛错。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 跑一条命令拿 stdout；失败 / 超时 / 不存在返回 null。 */
export type RunCommand = (
  file: string,
  args: string[],
  options: { timeoutMs: number },
) => Promise<string | null>;

export const defaultRunCommand: RunCommand = async (file, args, options) => {
  try {
    // stderr 由 execFile 收进回调、不继承给本进程 —— 这里只关心 stdout。
    const { stdout } = await execFileAsync(file, args, {
      encoding: 'utf8',
      timeout: options.timeoutMs,
      windowsHide: true,
      maxBuffer: 64 * 1024,
    });
    return stdout;
  } catch {
    // ENOENT（命令不存在）、非 0 退出码、超时（SIGTERM）、输出超限 —— 全部当「没查到」。
    return null;
  }
};

// ─────────────────────────── 输出解析（纯函数） ───────────────────────────

/** `reg query` 是不是 Windows 才有的命令。 */
const REG = 'reg';

/**
 * `reg query HKLM\...\Uninstall\QQ /v UninstallString` 的输出 → 卸载器路径。
 *
 * ```text
 * HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\QQ
 *     UninstallString    REG_SZ    "C:\Program Files\Tencent\QQNT\Uninstall.exe"
 * ```
 *
 * 值可能带参数（`"C:\...\Uninstall.exe" /S`），此时首尾引号不成对 —— 直接返回整串，
 * 调用方 `dirname` 后仍能拿到安装目录。
 */
export function parseUninstallString(stdout: string): string | null {
  for (const raw of stdout.split(/\r?\n/)) {
    const match = raw.match(/^\s*UninstallString\s+REG_\w+\s+(.+?)\s*$/);
    const value = match?.[1];
    if (!value) continue;
    return stripQuotes(value);
  }
  return null;
}

/**
 * `reg query "HKCR\tencent\shell\open\command" /ve` 的输出 → 协议处理器 exe。
 *
 * 默认值（`/ve`）的行格式和具名值不同：名字是 `(Default)` 或本地化的 `(默认)`。
 *
 * ```text
 * HKEY_CLASSES_ROOT\tencent\shell\open\command
 *     (Default)    REG_SZ    "C:\Program Files\Tencent\QQNT\versions\9.9.9\resources\app\timwp.exe" "%1"
 * ```
 *
 * 只取**第一个 token**：`"%1"` 及之后的参数都丢掉。
 */
export function parseDefaultCommand(stdout: string): string | null {
  for (const raw of stdout.split(/\r?\n/)) {
    const match = raw.match(/^\s*\((?:Default|默认)\)\s+REG_\w+\s+(.+?)\s*$/);
    const value = match?.[1];
    if (!value) continue;
    const exe = firstCommandToken(value);
    if (exe) return exe;
  }
  return null;
}

/** `mdfind` 的输出 → 第一条非空的 `.app` 路径。 */
export function parseMdfindApp(stdout: string): string | null {
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length > 0) return line;
  }
  return null;
}

/** 剥掉成对的外层引号；不成对时原样返回。 */
function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * 从命令串里取可执行文件：`"C:\...\timwp.exe" "%1"` → `C:\...\timwp.exe`。
 *
 * 引号包裹时取第一对引号内的内容；否则取第一个空白前的片段。
 */
function firstCommandToken(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  const token = trimmed.startsWith('"')
    ? (() => {
        const end = trimmed.indexOf('"', 1);
        return end === -1 ? '' : trimmed.slice(1, end);
      })()
    : (trimmed.split(/\s+/)[0] ?? '');
  // `"%1"` 这类占位符不是可执行文件：注册表里只写了参数、没写字面量的情况，
  // 与其把 `%1` 当路径，不如判定为「没查到」。
  if (!token || token.startsWith('%')) return null;
  return token;
}

// ─────────────────────────── 探测 ───────────────────────────

export interface QqHints {
  /** 注册表卸载项推出的安装根。 */
  installDir: string | null;
  /** 协议处理器 exe（`timwp.exe`），与 `wrapper.node` 同目录。 */
  protocolExe: string | null;
  /** macOS Spotlight 找到的 `.app` 路径。 */
  spotlightApp: string | null;
  sources: { installDir?: 'protocol' | 'registry' | 'spotlight' };
}

export const EMPTY_QQ_HINTS: QqHints = {
  installDir: null,
  protocolExe: null,
  spotlightApp: null,
  sources: {},
};

export interface DetectQqHintsOptions {
  platform?: NodeJS.Platform;
  run?: RunCommand;
  /** 单条命令的超时；默认 win32 1500ms / darwin 3000ms。 */
  timeoutMs?: number;
}

/**
 * 探测注册表 / Spotlight。
 *
 * Windows 的顺序与 WeQ 一致：**协议处理器优先，注册表兜底** —— 协议关联由安装器
 * 写入且不依赖 `Uninstall\QQ` 这一步（该键在改装 / 迁移 / 重命名后经常缺失）。
 *
 * 与 WeQ 的差异：WeQ 在 desktop 里用 electron 的 `getApplicationInfoForProtocol`
 * 拿协议 exe；WeqBot 没有 electron，改为直接查 `HKCR\tencent\shell\open\command`
 * （HKCR 是 HKLM + HKCU 的合并视图）。`tencent` 查不到再试 `mqqapi`。
 */
export async function detectQqHints(options: DetectQqHintsOptions = {}): Promise<QqHints> {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? defaultRunCommand;
  const timeoutMs = options.timeoutMs ?? (platform === 'win32' ? 1500 : 3000);

  if (platform === 'win32') return detectWin32(run, timeoutMs);
  if (platform === 'darwin') return detectDarwin(run, timeoutMs);
  return EMPTY_QQ_HINTS;
}

async function detectWin32(run: RunCommand, timeoutMs: number): Promise<QqHints> {
  let protocolExe: string | null = null;
  for (const protocol of ['tencent', 'mqqapi']) {
    const stdout = await run(REG, ['query', `HKCR\\${protocol}\\shell\\open\\command`, '/ve'], {
      timeoutMs,
    });
    if (!stdout) continue;
    protocolExe = parseDefaultCommand(stdout);
    if (protocolExe) break;
  }

  let installDir: string | null = null;
  const uninstallStdout = await run(
    REG,
    [
      'query',
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
      '/v',
      'UninstallString',
    ],
    { timeoutMs },
  );
  if (uninstallStdout) {
    const uninstaller = parseUninstallString(uninstallStdout);
    if (uninstaller) installDir = win32Dirname(uninstaller);
  }

  const sources: QqHints['sources'] = {};
  if (protocolExe) sources.installDir = 'protocol';
  else if (installDir) sources.installDir = 'registry';

  return { installDir, protocolExe, spotlightApp: null, sources };
}

async function detectDarwin(run: RunCommand, timeoutMs: number): Promise<QqHints> {
  const stdout = await run('mdfind', ['kMDItemCFBundleIdentifier == "com.tencent.qq"'], {
    timeoutMs,
  });
  const spotlightApp = stdout ? parseMdfindApp(stdout) : null;
  return {
    installDir: null,
    protocolExe: null,
    spotlightApp,
    sources: spotlightApp ? { installDir: 'spotlight' } : {},
  };
}

/**
 * 卸载器路径 → 安装目录。
 *
 * 用 `path.win32` 而不是宿主方言：这条路径可能来自 Windows 配置，而服务本身跑在
 * Linux（`reg` 的输出、用户手抄的路径都可能这样）。
 */
function win32Dirname(path: string): string {
  const executable = stripWindowsArgs(path.trim());
  const index = Math.max(executable.lastIndexOf('\\'), executable.lastIndexOf('/'));
  return index > 0 ? executable.slice(0, index) : executable;
}

/**
 * 从 Windows 命令行里剥出可执行文件部分。
 *
 * 不能简单地按空白切：`C:\Program Files\...` 本身就带空格。可靠的做法是找到
 * `.exe` 并截到它为止；没有 `.exe` 时（少见）才退回按空白切。
 */
export function stripWindowsArgs(command: string): string {
  const trimmed = command.trim();
  // `"C:\...\Uninstall.exe" /S` 这种首尾引号不成对的，先取出第一对引号里的内容。
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    if (end > 0) return trimmed.slice(1, end);
  }
  const exe = /\.exe\b/i.exec(trimmed);
  if (exe) return trimmed.slice(0, exe.index + exe[0].length);
  const firstSpace = trimmed.search(/\s/);
  return firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
}

// ─────────────────────────── 进程级缓存 ───────────────────────────

let cachedHints: { platform: NodeJS.Platform; value: QqHints } | undefined;
let pendingHints: { platform: NodeJS.Platform; promise: Promise<QqHints> } | undefined;

/**
 * 带**单飞 + 进程级缓存**的 `detectQqHints`。
 *
 * 探测结果是「这台机器装在哪」这种稳定事实，每次 HTTP 请求都起子进程不值得。
 * 负结果也缓存（没装 QQ 的机器不该反复起 `reg` / `mdfind`）。
 *
 * 失效入口是 {@link clearQqHintsCache}：设置页的「重新检查」与覆盖路径变更都会调它。
 */
export async function ensureQqHints(
  platform: NodeJS.Platform = process.platform,
  run?: RunCommand,
): Promise<QqHints> {
  if (cachedHints?.platform === platform) return cachedHints.value;
  if (pendingHints?.platform === platform) return pendingHints.promise;

  const promise = detectQqHints({ platform, ...(run ? { run } : {}) })
    .then((value) => {
      cachedHints = { platform, value };
      return value;
    })
    .finally(() => {
      if (pendingHints?.platform === platform) pendingHints = undefined;
    });

  pendingHints = { platform, promise };
  return promise;
}

/** 丢掉进程级缓存（设置页「重新检查」、覆盖路径变更时调用）。 */
export function clearQqHintsCache(): void {
  cachedHints = undefined;
  pendingHints = undefined;
}
