#!/usr/bin/env node
/**
 * 组装发布包：5 个平台 × 2 个变体。
 *
 * 变体：
 *   - `with-node`  压缩包里带一份官方 Node 运行时，解压即用；
 *   - `self-node`  只带代码 / 前端 / 原生组件，用本机 Node（>= 22.12.0）。
 *
 * 每个包的内容（解压后是一个 `weqbot/` 目录）：
 *
 *   weqbot/
 *     packages/node/src/cli.mjs     esbuild 打出来的单文件 CLI
 *     webui/dist/                   Vite 构建出来的控制台静态资源
 *     native/<platform>/<arch>/nt_helper.node
 *     config.example.json
 *     weqbot (sh) / weqbot.cmd      启动器（优先用同目录自带的 node）
 *     node / node.exe              仅 with-node 变体
 *     README.txt
 *
 * 目录布局不是随手定的，**要同时满足两处默认路径**（代码里没有 CLI 参数可改）：
 *   - `loader.ts` 的 `defaultNativeDir()`：`<cli.mjs 所在目录>/../../../native/<p>/<a>`，
 *     所以 cli.mjs 放在 `packages/node/src/` 下；
 *   - `webui/index.ts` 的 `defaultStaticDir()`：`<cli.mjs 所在目录>/../../../webui/dist`，
 *     所以静态资源放在 `webui/dist/`（不是 `packages/webui/dist/`）。
 *
 * 用法：
 *   node scripts/build-release.mjs                          # 全部 10 个包，版本取根 package.json
 *   node scripts/build-release.mjs --version 0.1.0          # 指定版本
 *   node scripts/build-release.mjs --variant self-node      # 只出「自备 node」的 5 个
 *   node scripts/build-release.mjs --platform linux-x64     # 只出某个平台（可逗号分隔）
 *   node scripts/build-release.mjs --out dist/release       # 产物目录（默认）
 *
 * 环境变量：
 *   WEQBOT_VERSION        等价于 --version
 *   WEQBOT_NODE_VERSION   自带 / 用于打包的 Node 版本，默认 22.23.5
 *
 * 依赖的外部工具：`tar`、`zip`（Windows 包用 zip 格式）、`unzip`（解压 Windows Node）。
 * 前置条件：`pnpm build:webui` 的产物、`pnpm native:fetch --all` 的原生产物。
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, copyFile, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 与 `scripts/fetch-native.mjs` 的 PLATFORMS 一一对应；`nodeDist` 是 nodejs.org 的发布后缀。 */
const PLATFORMS = {
  'win32-x64': { nodeDist: 'win-x64', archive: 'zip' },
  'linux-x64': { nodeDist: 'linux-x64', archive: 'tar.gz' },
  'linux-arm64': { nodeDist: 'linux-arm64', archive: 'tar.gz' },
  'darwin-x64': { nodeDist: 'darwin-x64', archive: 'tar.gz' },
  'darwin-arm64': { nodeDist: 'darwin-arm64', archive: 'tar.gz' },
};

const VARIANTS = {
  'with-node': { withNode: true, suffix: '-with-node' },
  'self-node': { withNode: false, suffix: '' },
};

/** 自带运行时 / 打包用的 Node 版本。和 CI 用的是同一版，发布包才算真跑过。 */
const DEFAULT_NODE_VERSION = '22.23.5';

// ─────────────────────────── 参数 ───────────────────────────

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const opt = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (has('--help') || has('-h')) {
  const self = await readFile(fileURLToPath(import.meta.url), 'utf8');
  const doc = self.slice(self.indexOf('/**') + 3, self.indexOf('*/'));
  console.log(
    doc
      .split('\n')
      .map((line) => line.replace(/^ \* ?/, ''))
      .join('\n')
      .trim(),
  );
  process.exit(0);
}

const nodeVersion = process.env.WEQBOT_NODE_VERSION ?? DEFAULT_NODE_VERSION;

function selectPlatforms() {
  const raw = opt('--platform');
  const wanted = raw
    ? raw
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
    : Object.keys(PLATFORMS);
  for (const name of wanted) {
    if (!PLATFORMS[name]) {
      throw new Error(`不认识的平台 ${name}；可用：${Object.keys(PLATFORMS).join(' / ')}`);
    }
  }
  return wanted;
}

function selectVariants() {
  const raw = opt('--variant');
  const wanted = raw
    ? raw
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
    : Object.keys(VARIANTS);
  for (const name of wanted) {
    if (!VARIANTS[name]) {
      throw new Error(`不认识的变体 ${name}；可用：${Object.keys(VARIANTS).join(' / ')}`);
    }
  }
  return wanted;
}

const outDir = resolve(root, opt('--out') ?? join('dist', 'release'));
const workDir = resolve(root, '.release');
const cacheDir = join(workDir, 'cache');
const bundleFile = join(workDir, 'bundle', 'packages', 'node', 'src', 'cli.mjs');

/** 版本：`--version` > `WEQBOT_VERSION` > 根 package.json；去掉开头的 `v`。 */
async function resolveVersion() {
  const raw =
    opt('--version') ??
    process.env.WEQBOT_VERSION ??
    JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
  return String(raw).replace(/^v/, '');
}

// ─────────────────────────── 小工具 ───────────────────────────

const log = (message) => process.stdout.write(`[release] ${message}\n`);

function run(command, args, options = {}) {
  return execFileSync(command, args, { stdio: 'inherit', ...options });
}

function requireTool(name, hint) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: 'ignore' });
  } catch {
    throw new Error(`缺少命令 ${name}${hint ? `：${hint}` : ''}`);
  }
}

async function sha256File(file) {
  const hash = createHash('sha256');
  hash.update(await readFile(file));
  return hash.digest('hex');
}

/** 从 nodejs.org 取一份官方运行时；已有缓存就不再下载（发版机器 / CI 复用）。 */
async function fetchNodeDist(platform) {
  const spec = PLATFORMS[platform];
  const asset = `node-v${nodeVersion}-${spec.nodeDist}.${spec.archive}`;
  const tarball = join(cacheDir, asset);
  const extracted = join(cacheDir, `node-v${nodeVersion}-${spec.nodeDist}`);
  const binary = spec.nodeDist.startsWith('win') ? 'node.exe' : 'node';

  if (existsSync(join(extracted, binary)) || existsSync(join(extracted, 'bin', binary))) {
    return join(existsSync(join(extracted, binary)) ? extracted : join(extracted, 'bin'), binary);
  }
  await mkdir(cacheDir, { recursive: true });
  if (!existsSync(tarball)) {
    const url = `https://nodejs.org/dist/v${nodeVersion}/${asset}`;
    log(`下载 Node ${nodeVersion}（${spec.nodeDist}）`);
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) throw new Error(`下载失败 ${response.status}：${url}`);
    await writeFile(tarball, Buffer.from(await response.arrayBuffer()));
  }
  if (spec.archive === 'zip') run('unzip', ['-q', '-o', tarball, '-d', cacheDir]);
  else run('tar', ['-xf', tarball, '-C', cacheDir]);
  return join(existsSync(join(extracted, binary)) ? extracted : join(extracted, 'bin'), binary);
}

const LAUNCHER_SH = `#!/bin/sh
# WeqBot 启动器：优先用同目录里自带的 node，没有 / 不可执行时用 PATH 里的 node。
set -e
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -x "$DIR/node" ]; then NODE="$DIR/node"; else NODE=node; fi
exec "$NODE" "$DIR/packages/node/src/cli.mjs" "$@"
`;

const LAUNCHER_CMD = `@echo off
setlocal
set "DIR=%~dp0"
if exist "%DIR%node.exe" (
  "%DIR%node.exe" "%DIR%packages\\node\\src\\cli.mjs" %*
) else (
  node "%DIR%packages\\node\\src\\cli.mjs" %*
)
`;

function readmeText(version, platform, variant) {
  const withNode = VARIANTS[variant].withNode;
  return [
    `WeqBot ${version} — ${platform}`,
    '',
    withNode
      ? `自带 Node ${nodeVersion}，解压后直接运行，不需要另装 Node。`
      : '需要本机已装 Node.js >= 22.12.0。',
    '',
    '运行：',
    platform.startsWith('win32') ? '  weqbot.cmd --help' : '  ./weqbot --help',
    platform.startsWith('win32')
      ? '  weqbot.cmd                      启动控制台（浏览器里选账号登录）'
      : '  ./weqbot                        启动控制台（浏览器里选账号登录）',
    platform.startsWith('win32')
      ? '  weqbot.cmd --account <uin>      直接上线某个账号'
      : '  ./weqbot --account <uin>        直接上线某个账号',
    '',
    '这个目录里有什么：',
    '  packages/node/src/cli.mjs   CLI（单文件，已打包）',
    '  webui/dist/                 控制台静态资源',
    `  native/${platform.replace('-', '/')}/nt_helper.node   原生组件`,
    '  config.example.json         配置样例（字段说明见文档）',
    '',
    '原生组件目录可以用 --native-dir 或 WEQBOT_NATIVE_DIR 改到别处。',
    '文档：https://github.com/weq-devs/WeqBot/tree/main/docs',
    '',
  ].join('\n');
}

// ─────────────────────────── 打包 ───────────────────────────

/** 把 CLI 打成单文件 ESM。 */
async function bundleCli() {
  await mkdir(dirname(bundleFile), { recursive: true });
  await build({
    entryPoints: [join(root, 'packages', 'node', 'src', 'cli.ts')],
    outfile: bundleFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    legalComments: 'none',
    logLevel: 'warning',
    // 依赖里还有 CJS（ws）：ESM 输出里没有 `require`，用 createRequire 补上，
    // 否则 CJS 模块内部的 `require('events')` 会在启动时就抛错。
    banner: {
      js: "import { createRequire as __weqbotCreateRequire } from 'node:module'; const require = __weqbotCreateRequire(import.meta.url);",
    },
  });
  const { size } = await stat(bundleFile);
  log(`CLI 已打包：${(size / 1024 / 1024).toFixed(1)} MB → ${bundleFile.slice(root.length + 1)}`);
}

/** 组装 `weqbot/` 目录（暂存区）。 */
async function assemble(version, platform, variant) {
  const name = `weqbot-${version}-${platform}${VARIANTS[variant].suffix}`;
  const stage = join(workDir, 'stage', name);
  const app = join(stage, 'weqbot');
  await rm(stage, { recursive: true, force: true });

  // 布局见文件头注释：cli.mjs 必须在 packages/node/src 下，静态资源在 webui/dist 下。
  await mkdir(join(app, 'packages', 'node', 'src'), { recursive: true });
  await copyFile(bundleFile, join(app, 'packages', 'node', 'src', 'cli.mjs'));
  await cp(join(root, 'packages', 'webui', 'dist'), join(app, 'webui', 'dist'), {
    recursive: true,
  });

  const [osName, arch] = platform.split('-');
  await mkdir(join(app, 'native', osName, arch), { recursive: true });
  await copyFile(
    join(root, 'native', osName, arch, 'nt_helper.node'),
    join(app, 'native', osName, arch, 'nt_helper.node'),
  );
  await copyFile(
    join(root, 'packages', 'node', 'config.example.json'),
    join(app, 'config.example.json'),
  );

  const launcher = join(app, platform.startsWith('win32') ? 'weqbot.cmd' : 'weqbot');
  await writeFile(launcher, platform.startsWith('win32') ? LAUNCHER_CMD : LAUNCHER_SH);
  if (!platform.startsWith('win32')) await chmod(launcher, 0o755);

  if (VARIANTS[variant].withNode) {
    const source = await fetchNodeDist(platform);
    const target = join(app, platform.startsWith('win32') ? 'node.exe' : 'node');
    await copyFile(source, target);
    if (!platform.startsWith('win32')) await chmod(target, 0o755);
    const license = join(dirname(dirname(source)), 'LICENSE');
    if (existsSync(license)) await copyFile(license, join(app, 'NODE-LICENSE.txt'));
  }

  await writeFile(join(app, 'README.txt'), readmeText(version, platform, variant));

  const archiveName = `${name}.${PLATFORMS[platform].archive}`;
  const archivePath = join(outDir, archiveName);
  await mkdir(outDir, { recursive: true });
  await rm(archivePath, { force: true });
  if (PLATFORMS[platform].archive === 'zip') {
    run('zip', ['-q', '-r', '-y', archivePath, 'weqbot'], { cwd: stage });
  } else {
    run('tar', ['-czf', archivePath, '-C', stage, 'weqbot']);
  }
  const { size } = await stat(archivePath);
  log(`  ${archiveName.padEnd(52)} ${(size / 1024 / 1024).toFixed(1)} MB`);
  await rm(stage, { recursive: true, force: true });
  return archiveName;
}

// ─────────────────────────── 主流程 ───────────────────────────

async function main() {
  const version = await resolveVersion();
  const platforms = selectPlatforms();
  const variants = selectVariants();

  if (!existsSync(join(root, 'packages', 'webui', 'dist', 'index.html'))) {
    throw new Error('缺 packages/webui/dist —— 先跑 `pnpm build:webui`');
  }
  const missingNative = platforms.filter(
    (platform) => !existsSync(join(root, 'native', ...platform.split('-'), 'nt_helper.node')),
  );
  if (missingNative.length > 0) {
    throw new Error(`缺原生组件：${missingNative.join(', ')} —— 先跑 \`pnpm native:fetch --all\``);
  }

  requireTool('tar');
  if (platforms.some((platform) => PLATFORMS[platform].archive === 'zip')) {
    requireTool('zip', 'Windows 包用 zip 格式；Linux 上 `apt-get install zip`');
  }
  if (variants.includes('with-node') && platforms.some((p) => p.startsWith('win32'))) {
    requireTool('unzip', '解压 Windows 版 Node；Linux 上 `apt-get install unzip`');
  }

  log(`版本 ${version}；平台 ${platforms.join(' / ')}；变体 ${variants.join(' / ')}`);
  log(`Node ${nodeVersion}（with-node 变体自带）`);
  await bundleCli();

  const produced = [];
  for (const platform of platforms) {
    for (const variant of variants) produced.push(await assemble(version, platform, variant));
  }

  // 校验清单一并发布：下载后先 `sha256sum -c SHA256SUMS.txt` 再解压。
  const lines = [];
  for (const name of produced) lines.push(`${await sha256File(join(outDir, name))}  ${name}`);
  await writeFile(join(outDir, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`);

  log(`完成：${produced.length} 个包 → ${outDir.slice(root.length + 1)}`);
}

try {
  await main();
} catch (error) {
  console.error(`✘ ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
