/**
 * 一键修改版本号 —— 把 monorepo 里所有 package.json 的 `version` 统一改成目标版本。
 *
 * 用法：
 *   pnpm run version:set 0.5.0            # 实际写入
 *   pnpm run version:set 0.5.0 --dry-run  # 只打印将要修改的文件
 *   （也支持带 v 前缀：pnpm run version:set v0.5.0）
 *
 * 覆盖范围：仓库根 + apps/* + packages/* + docs 的 package.json（跳过 node_modules /
 * dist / .release 等产物目录）。pnpm-lock.yaml 不动 —— 下次 `pnpm i` 自然对齐。
 *
 * `docs/` 现在是主仓 workspace 里的独立包，所以一起改。将来它变成
 * `weq-devs/WeqBotDocs` 的 submodule 后，脚本会通过 `.gitmodules` 识别并自动跳过：
 * 往 submodule 里写文件会让主仓多出「未提交的 submodule 改动」，很容易被误提交或
 * 被 `git checkout` 静默丢掉。
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { versionInput } from './version-input.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const raw = args.find((a) => !a.startsWith('--'));
const version = versionInput(raw);

if (!version) {
  console.error('用法: pnpm run version:set <x.y.z> [--dry-run]');
  process.exit(1);
}

/** `.gitmodules` 里登记的 submodule 路径；这些目录不写。 */
function submodulePaths() {
  const file = join(repoRoot, '.gitmodules');
  if (!existsSync(file)) return new Set();
  const paths = new Set();
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    const match = line.match(/^\s*path\s*=\s*(.+?)\s*$/);
    if (match) paths.add(match[1]);
  }
  return paths;
}

/** 目标 package.json 清单（根 + 一级 workspace 包；submodule 跳过）。 */
function targets() {
  const list = [join(repoRoot, 'package.json')];
  const submodules = submodulePaths();
  for (const scope of ['apps', 'packages']) {
    const dir = join(repoRoot, scope);
    if (!existsSync(dir) || submodules.has(scope)) continue;
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      if (!name.isDirectory()) continue;
      const pkg = join(dir, name.name, 'package.json');
      if (existsSync(pkg)) list.push(pkg);
    }
  }
  // `docs` 本身就是一个 workspace 包（不是 `docs/*` 的父目录）。
  if (!submodules.has('docs')) {
    const pkg = join(repoRoot, 'docs', 'package.json');
    if (existsSync(pkg)) list.push(pkg);
  }
  return list;
}

let changed = 0;
for (const pkg of targets()) {
  const json = JSON.parse(readFileSync(pkg, 'utf-8'));
  if (json.version === version) {
    console.log(`  跳过（已是 ${version}）: ${pkg.replace(`${repoRoot}/`, '')}`);
    continue;
  }
  const old = json.version;
  json.version = version;
  if (!dryRun) {
    writeFileSync(pkg, `${JSON.stringify(json, null, 2)}\n`);
  }
  changed += 1;
  console.log(`  ${old} → ${version}: ${pkg.replace(`${repoRoot}/`, '')}`);
}

console.log(
  dryRun
    ? `[dry-run] 将修改 ${changed} 处版本号 → ${version}`
    : `已把 ${changed} 处版本号统一到 ${version}。记得运行 pnpm i 刷新 lockfile。`,
);
