/**
 * 用户手填路径的**归一化**（纯函数，零副作用）。
 *
 * 这一层只做「把用户可能选错的那一层拨回去」，不猜、不补全：
 *
 * - 数据根：QQ 允许把数据目录搬到任意位置（`D:\QQData`、`E:\备份\QQ`），所以**不做
 *   目录名校验**；唯一的修正是常见的手滑 —— 用户在文件选择器里点进了
 *   `<root>/<uin>` 或 `<root>/nt_qq_<hash>` 这样的**账户目录**，此时上跳一层。
 * - 安装根：用户可能选到 `QQ.exe` 本身、`resources/app`、`versions/<v>`，
 *   甚至 macOS 的 `QQ.app/Contents/Resources/app`，都要还原成「装 QQ 的那个目录」。
 *
 * **Windows 路径串必须用 `path.win32`**：本项目在 Linux / macOS 上也要处理用户从
 * Windows 配置里抄来的 `D:\...`，用 POSIX 语义的 `dirname` 会把它切成 `.`。
 * 因此这里所有路径运算都按 `platform` 选 `win32` / `posix` 方言，而不是用宿主默认。
 */

import { existsSync, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';

/** 按目标平台取路径方言。 */
function pathOf(platform: NodeJS.Platform): typeof posix {
  return platform === 'win32' ? win32 : posix;
}

/** 归一化依赖，测试可替换。 */
export interface NormalizeFs {
  exists(path: string): boolean;
  isFile(path: string): boolean;
}

const REAL_FS: NormalizeFs = {
  exists: (path) => existsSync(path),
  isFile: (path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
};

/**
 * 是不是一个「看起来绝对」的路径。
 *
 * 用于拒绝设置页里的相对路径：相对路径会按**服务进程的 cwd** 解析，用户以为是
 * `QQ` 目录、实际指到别处，这类错误很难在报错信息里看出来。
 * 两种方言都算：`C:\...` / `\\srv\share` / `/opt/...`。
 */
export function looksAbsolutePath(picked: string): boolean {
  return win32.isAbsolute(picked) || posix.isAbsolute(picked);
}

/**
 * 判断 `p` 是不是**账户目录**（而不是数据根）。
 *
 * - win32：`<root>/<uin>` —— 要求 `<p>/nt_qq/nt_db` 存在，且 `<p>/nt_qq/global`
 *   **不**存在。后一条防误判：数据根本身完全可以叫 `D:\1234`，而数据根旁边有
 *   `nt_qq/global`、账户目录没有。
 * - linux / macOS：`<root>/nt_qq_<hash>` —— 直接就是 `<p>/nt_db`，没有中间层。
 */
function isAccountDataDir(picked: string, platform: NodeJS.Platform, fs: NormalizeFs): boolean {
  const path = pathOf(platform);
  const base = path.basename(picked);
  if (/^\d+$/.test(base)) {
    return (
      fs.exists(path.join(picked, 'nt_qq', 'nt_db')) &&
      !fs.exists(path.join(picked, 'nt_qq', 'global'))
    );
  }
  if (/^nt_qq_[0-9a-f]+$/i.test(base)) {
    return fs.exists(path.join(picked, 'nt_db'));
  }
  return false;
}

/**
 * 把用户选的数据目录归一化到**数据根**。
 *
 * - 去掉尾部分隔符（`D:\QQData\` → `D:\QQData`）；
 * - **裸盘根原样保留**：`D:\` 去掉分隔符会变成驱动器相对路径 `D:`，语义完全不同；
 * - 选到账户目录时上跳一层。
 *
 * 不做存在性校验 —— 调用方自己决定要不要在落盘前 `existsSync`。
 */
export function normalizeQqDataRoot(
  picked: string,
  platform: NodeJS.Platform = process.platform,
  fs: NormalizeFs = REAL_FS,
): string {
  const path = pathOf(platform);
  // 裸盘根（`D:\`、`d:/`）必须原样返回，见函数注释。
  if (platform === 'win32' && /^[A-Za-z]:[\\/]$/.test(picked)) return picked;

  const trimmed = picked.replace(/[\\/]+$/, '');
  if (!trimmed) return picked;
  if (isAccountDataDir(trimmed, platform, fs)) {
    const parent = path.dirname(trimmed);
    return parent === trimmed ? trimmed : parent;
  }
  return trimmed;
}

/**
 * 文件名看起来是不是 QQ 的可执行文件。
 *
 * 只按平台允许的形态判定：Linux/macOS 是小写 `qq`，Windows 是 `QQ.exe`
 * （大小写不敏感）。**不能**用不区分大小写的通配：Linux 的安装根常叫 `/opt/QQ`，
 * 那样会把目录当成文件、再上跳一层到 `/opt`。
 */
function isQqExecutableName(base: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') return base.toLowerCase() === 'qq.exe';
  return base === 'qq';
}

/**
 * 把用户选的安装目录归一化到**安装根**（装 QQ 的那个目录）。
 *
 * 接受并还原这些形态：
 *
 * ```text
 * <root>/qq                          (Linux 可执行文件)        → <root>
 * <root>/QQ.exe                      (Windows 可执行文件)      → <root>
 * <root>/resources/app               (Linux 的 app 目录)       → <root>
 * <root>/versions/<v>/resources/app  (Windows 典型选法)        → <root>
 * <root>/versions/<v>                (Windows 版本目录)        → <root>
 * /Applications/QQ.app               (macOS 应用包)            → 原样
 * /Applications/QQ.app/Contents/Resources/app                 → /Applications/QQ.app
 * ```
 *
 * 判定顺序「从最具体到最一般」：先看选的是不是文件，再逐级识别已知的中间层。
 */
export function normalizeQqInstallDir(
  picked: string,
  platform: NodeJS.Platform = process.platform,
  fs: NormalizeFs = REAL_FS,
): string {
  const path = pathOf(platform);
  let dir = picked.replace(/[\\/]+$/, '');
  if (!dir) return picked;

  // 选到的是文件（QQ.exe / qq）：先取所在目录。文件不存在时按**文件名形状**判断 ——
  // 用户从配置文件里抄来的路径可能暂时不可用，但那仍然是「可执行文件」而不是目录。
  //
  // 按平台判定而不是大小写不敏感匹配：Linux 的安装目录常常就叫 `/opt/QQ`，
  // 而 Linux 的可执行文件是小写 `qq` —— 一个不区分大小写的规则会把安装根误认成文件。
  if (fs.isFile(dir) || isQqExecutableName(path.basename(dir), platform)) {
    dir = path.dirname(dir);
  }

  // macOS：`.app/Contents/Resources/app` → `.app`；`.app` 本身保持不动。
  if (/([\\/])Contents[\\/]Resources[\\/]app$/i.test(dir)) {
    return path.resolve(dir, '..', '..', '..');
  }

  // 任意平台的 `resources/app` → 安装根。
  if (/([\\/])resources[\\/]app$/i.test(dir)) dir = path.resolve(dir, '..', '..');

  // Windows 的 `versions/<v>` → 安装根（`..` 是 versions，再 `..` 是根）。
  if (path.basename(path.dirname(dir)).toLowerCase() === 'versions') {
    return path.resolve(dir, '..', '..');
  }

  return dir;
}
