#!/usr/bin/env node
/**
 * 架构护栏。
 *
 * 两条不可协商的约束靠它守：
 *
 *   1. **打包进 WeQ 时是纯 TS**：除 `packages/node` 外，任何文件都不得出现
 *      `.node` / `process.dlopen` / `createRequire`，也不得 import `@weq/*`。
 *   2. **依赖方向**：只能向下依赖（见 LAYERS），不允许反向或跨层。
 *
 * 为什么用脚本而不是 biome 的 noRestrictedImports：分层规则要读"当前文件属于哪个包"，
 * biome 的规则是路径 glob，写出来会是一串重复配置，改结构时容易漏。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const PKG_NAME = (dir) => `@weqbot/${dir}`;

/** 允许的依赖方向：包 → 可以直接 import 的 @weqbot 包。 */
const LAYERS = {
  common: [],
  wire: ['common'],
  protocol: ['common', 'wire'],
  session: ['common', 'wire', 'protocol'],
  onebot: ['common', 'protocol', 'session'],
  bot: ['common', 'wire', 'protocol', 'session', 'onebot'],
  control: ['common', 'wire'],
  node: ['common', 'wire', 'protocol', 'session', 'onebot', 'bot', 'control'],
};

/** 只有这个包可以加载原生组件。 */
const NATIVE_HOST = 'node';

const IMPORT_RE = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;

/** 注释里会举反例（`from '@weq/native'`），先剥掉再扫，避免误报。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(path));
    else if (/\.(ts|mts|js|mjs)$/.test(entry.name)) out.push(path);
  }
  return out;
}

const violations = [];

for (const pkg of Object.keys(LAYERS)) {
  const srcDir = join(root, 'packages', pkg, 'src');
  let files;
  try {
    files = listFiles(srcDir);
  } catch {
    continue;
  }

  const allowed = new Set(LAYERS[pkg].map(PKG_NAME));
  const self = PKG_NAME(pkg);

  for (const file of files) {
    const rel = relative(root, file);
    const raw = readFileSync(file, 'utf8');
    const source = stripComments(raw);

    for (const match of source.matchAll(IMPORT_RE)) {
      const specifier = match[1];

      if (specifier === self) {
        violations.push(`${rel}: 自引用 ${self}`);
        continue;
      }

      if (specifier.startsWith('@weq/')) {
        violations.push(`${rel}: 不得依赖 WeQ 私有包 ${specifier}`);
        continue;
      }
      if (specifier === '@weqbot/node' || specifier.startsWith('@weqbot/node/')) {
        violations.push(`${rel}: 不得依赖 @weqbot/node（会把 .node 带进宿主）`);
        continue;
      }
      if (specifier.startsWith('@weqbot/')) {
        const target = specifier.slice('@weqbot/'.length).split('/')[0];
        if (target === pkg) continue;
        if (!allowed.has(`@weqbot/${target}`)) {
          violations.push(
            `${rel}: 跨层依赖 @weqbot/${target}（${pkg} 只允许 ${[...allowed].join(', ') || '无'}）`,
          );
        }
      }
    }

    if (pkg !== NATIVE_HOST) {
      if (/\.node['"]/.test(source)) {
        violations.push(`${rel}: 只有 @weqbot/node 可以引用 .node 文件`);
      }
      if (/\bprocess\.dlopen\b/.test(source)) {
        violations.push(`${rel}: 只有 @weqbot/node 可以 process.dlopen`);
      }
      if (/\bcreateRequire\b/.test(source)) {
        violations.push(`${rel}: 只有 @weqbot/node 可以 createRequire`);
      }
    }
  }
}

if (violations.length > 0) {
  process.stderr.write(`架构检查失败（${violations.length} 项）：\n`);
  for (const violation of violations) process.stderr.write(`  - ${violation}\n`);
  process.exit(1);
}

process.stdout.write('架构检查通过：依赖方向正确，除 @weqbot/node 外无原生加载。\n');
