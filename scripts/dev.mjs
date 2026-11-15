#!/usr/bin/env node
/**
 * 开发期一键启动：依赖 → 原生组件 → 前端产物 → 控制台。
 *
 * 为什么需要它：从零 clone 之后直接 `pnpm dev:cli` 会踩两个坑，而且都不会自己说清楚：
 *
 *   1. **原生组件不能直接取 release 产物**。发布仓里锚定的那份是旧 napi 绑定构建，
 *      导出里没有 `openSession` / `attachPushSink`，只能登录换票，跑不了 mode2 上线。
 *      开发期要用本地 `nt_helper` 的 cargo / napi 构建（`native:fetch --from-file`）。
 *      等 release 产物的能力补齐后，这里的本地构建分支会自然不再被走到。
 *   2. **`packages/webui/dist` 不入库**。不先 `build:webui`，控制台只会提供 API，
 *      页面是空白的（终端里也只有一行「没找到 webui/dist」的 hint）。
 *
 * 用法：
 *   pnpm dev                     # 依赖 / native / 前端按需补齐，然后起控制台
 *   pnpm dev -- --account <uin>  # 后面的参数原样交给 CLI（--config / --verbose / ...）
 *   pnpm dev -- --release        # 跳过本地构建，强制走 `native:fetch` 的 release 产物
 *   pnpm dev -- --rebuild        # 无条件重建前端
 *   pnpm dev -- --no-build       # 不构建前端（用现有 dist，或只打算调 API）
 *
 * 已就绪的东西不会重复做：native 能力齐就跳过，dist 比源码新就跳过。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const hostTag = `${process.platform}-${process.arch}`;
const nativeDir = join(root, 'native', process.platform, process.arch);
const nativePath = join(nativeDir, 'nt_helper.node');

/** 跑 mode2 上线至少需要这几个出口；缺任何一个都说明这份 native 太旧。 */
const REQUIRED_CAPABILITIES = ['openSession', 'attachPushSink'];

// ─────────────────────────── 参数 ───────────────────────────

const own = new Set(['--release', '--rebuild', '--no-build', '-h', '--help']);
const ownArgs = process.argv.slice(2).filter((arg) => own.has(arg));
const passthrough = process.argv.slice(2).filter((arg) => !own.has(arg));
const forceRelease = ownArgs.includes('--release');
const forceRebuild = ownArgs.includes('--rebuild');
const noBuild = ownArgs.includes('--no-build');

if (ownArgs.includes('-h') || ownArgs.includes('--help')) {
  process.stdout.write(
    [
      'weqbot dev — 一键准备并启动开发环境',
      '',
      '  依赖：node_modules 缺失时自动 pnpm install',
      '  native：优先本地 nt_helper 构建；没有时取 release 产物并检查能力',
      '  前端：dist 比源码旧时自动 build:webui',
      '  启动：node --import tsx packages/node/src/cli.ts，参数原样透传',
      '',
      '  --release    强制使用 release 产物（跳过本地构建）',
      '  --rebuild    无条件重建前端',
      '  --no-build   不构建前端',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

// ─────────────────────────── 小工具 ───────────────────────────

const log = (message) => process.stdout.write(`[dev] ${message}\n`);

function run(command, args, options = {}) {
  log(`$ ${[command, ...args].join(' ')}`);
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} 退出码 ${result.status ?? result.signal}`);
  }
}

/** 在隔离子进程里问一份 `.node` 导出了哪些函数（与 `native:fetch` 的探测口径一致）。 */
function capabilitiesOf(addonPath) {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `
      const addon = require(process.argv[1]);
      process.stdout.write(JSON.stringify(Object.keys(addon).filter((key) => typeof addon[key] === 'function')));
    `,
      addonPath,
    ],
    { encoding: 'utf8', timeout: 20_000, windowsHide: true },
  );
  if (result.status !== 0) return new Set();
  try {
    return new Set(JSON.parse(result.stdout));
  } catch {
    return new Set();
  }
}

function missingCapabilities(addonPath) {
  const present = capabilitiesOf(addonPath);
  return REQUIRED_CAPABILITIES.filter((name) => !present.has(name));
}

/** 本地 `nt_helper` 源码目录：`NT_HELPER_DIR`，默认与 WeqBot 同级的 `../nt_helper`。 */
function localHelperDir() {
  for (const candidate of [
    process.env.NT_HELPER_DIR,
    resolve(root, '..', 'nt_helper'),
    resolve(root, '..', 'nt_helper_dev'),
  ]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** 本地 napi 构建产物：`index.<platform>-<arch>-<abi>.node`。 */
function findLocalBuild() {
  const dir = localHelperDir();
  if (!dir) return undefined;
  const prefix = `index.${hostTag}-`;
  const candidates = readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.node'))
    .map((name) => join(dir, name));
  // 同时装了 gnu / musl 时，优先与本机 libc 匹配的那份。
  const glibc = process.report?.getReport?.().header?.glibcVersionRuntime;
  const preferred = candidates.find((path) =>
    glibc ? path.includes('-gnu') : path.includes('-musl'),
  );
  return preferred ?? candidates[0];
}

function newestMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(path));
    else if (entry.isFile()) newest = Math.max(newest, statSync(path).mtimeMs);
  }
  return newest;
}

// ─────────────────────────── 1. 依赖 ───────────────────────────

if (!existsSync(join(root, 'node_modules', '.pnpm', 'lock.yaml'))) {
  log('node_modules 不完整，先安装依赖');
  run('pnpm', ['install', '--frozen-lockfile']);
}

// ─────────────────────────── 2. 原生组件 ───────────────────────────

function installNative() {
  if (existsSync(nativePath)) {
    const missing = missingCapabilities(nativePath);
    if (missing.length === 0) {
      log(`native 就绪（能力齐全）：${nativePath}`);
      return;
    }
    log(`现有 native 缺少 ${missing.join(', ')}，需要换一份`);
  } else {
    log('缺少原生组件');
  }

  if (!forceRelease) {
    const local = findLocalBuild();
    if (local) {
      log(`使用本地构建：${local}`);
      run('node', ['scripts/fetch-native.mjs', '--from-file', local]);
      return;
    }
    log('没找到本地 nt_helper 构建，回落到 release 产物');
  }

  run('node', ['scripts/fetch-native.mjs']);

  const missing = missingCapabilities(nativePath);
  if (missing.length > 0) {
    throw new Error(
      `release 产物缺少 ${missing.join(', ')} —— 跑不了 mode2 上线。\n` +
        '这是开发期的已知状况：release 仓那份还是旧绑定构建。请改用本地构建：\n' +
        '  cd ../nt_helper && pnpm build        # 或 cargo build --release\n' +
        '  pnpm dev                             # 会自动从 ../nt_helper 取\n' +
        '也可以用 NT_HELPER_DIR 指向 nt_helper 源码目录。',
    );
  }
  log('release 产物能力齐全，已安装');
}

installNative();

// ─────────────────────────── 3. 前端产物 ───────────────────────────

const distIndex = join(root, 'packages', 'webui', 'dist', 'index.html');
const webuiRoot = join(root, 'packages', 'webui');

function distIsStale() {
  if (!existsSync(distIndex)) return true;
  const builtAt = statSync(distIndex).mtimeMs;
  const sources = [join(webuiRoot, 'src'), join(webuiRoot, 'public')].filter((dir) =>
    existsSync(dir),
  );
  const newestSource = Math.max(
    ...sources.map((dir) => newestMtime(dir)),
    statSync(join(webuiRoot, 'index.html')).mtimeMs,
    statSync(join(webuiRoot, 'vite.config.ts')).mtimeMs,
  );
  return newestSource > builtAt;
}

if (noBuild) {
  log('跳过前端构建（--no-build）');
} else if (forceRebuild || distIsStale()) {
  log(forceRebuild ? '重建前端（--rebuild）' : '前端产物缺失或比源码旧，重新构建');
  run('pnpm', ['--filter', '@weqbot/webui', 'build']);
} else {
  log('前端产物是最新的，跳过构建');
}

// ─────────────────────────── 4. 启动 ───────────────────────────

log('启动控制台（参数原样交给 CLI）');
const child = spawn(
  process.execPath,
  ['--import', 'tsx', join(root, 'packages', 'node', 'src', 'cli.ts'), ...passthrough],
  { cwd: root, stdio: 'inherit' },
);

// 信号透传给 CLI：它自己会走 closeSession → UnRegister，父进程只负责别提前退出。
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => child.kill(signal));
}

child.on('exit', (code, signal) => {
  if (signal) process.exit(0);
  process.exit(code ?? 0);
});
