#!/usr/bin/env node
/**
 * 把仓库里的真实 QQ 号替换成示例值。
 *
 * 文档站与主仓都要公开。真实 uin 出现在三类地方：
 *
 *   1. **示例配置**（`config.example.json`、`docs/**`）—— 陌生人最先看到的东
 *      西，用真号做示例不合适；
 *   2. **测试夹具**（`packages/*\/test/`）—— 值本身无所谓，只要前后一致；
 *   3. **协议注释**（`packages/protocol/src/`）—— 真机抓包时记下的字段值，
 *      换成示例值不影响结论，因为讲的是字段布局而不是具体号码。
 *
 * 用法：
 *
 *   node scripts/anonymize-uin.mjs           # 写盘
 *   node scripts/anonymize-uin.mjs --check   # 只报错，不写盘（CI 用）
 *
 * ## 为什么不做「按出现顺序编号」
 *
 * 同一个号码在源码里往往成对出现（`1707889225 ↔ 2863253201` 双向验证），
 * 只要映射表是固定的，替换后这个关系仍然成立。所以用固定表而不是动态编号。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const checkOnly = process.argv.includes('--check');

/**
 * 真实号码 → 示例值。
 *
 * 选 10001 / 10002 这类：OneBot 社区惯用的示例号，一眼看得出不是真的。
 */
const REPLACEMENTS = [
  // 作者本人的测试账号（也是提交作者邮箱里的那一个）
  ['1707889225', '10001'],
  // 测试好友 / 测试群
  ['2863253201', '10002'],
  ['673646675', '10003'],
];

/** 只扫这些扩展名；二进制与生成物不碰。 */
const EXTENSIONS = ['.md', '.ts', '.mts', '.json', '.mjs', '.vue'];

/** 不入库的路径（生成物、依赖）。 */
function isIgnored(path) {
  return (
    path.includes('node_modules/') ||
    path.includes('/dist/') ||
    path.includes('/cache/') ||
    path.startsWith('schema/onebot-actions.json') ||
    // 脚本自己的映射表当然含原文，跳过。
    path === 'scripts/anonymize-uin.mjs'
  );
}

function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split('\0')
    .filter((p) => p && EXTENSIONS.some((ext) => p.endsWith(ext)) && !isIgnored(p))
    .map((p) => join(root, p));
}

const changed = [];
const found = [];

for (const file of trackedFiles()) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const before = text;
  for (const [from, to] of REPLACEMENTS) {
    if (text.includes(from)) {
      found.push({ file: relative(root, file), uin: from });
      text = text.split(from).join(to);
    }
  }
  if (text !== before) {
    changed.push(relative(root, file));
    if (!checkOnly) writeFileSync(file, text);
  }
}

if (checkOnly) {
  if (found.length > 0) {
    process.stderr.write(
      `✖ ${found.length} 处真实 QQ 号未替换：\n` +
        found.map((x) => `  ${x.file}: ${x.uin}`).join('\n') +
        '\n  跑 `pnpm anonymize:uin` 处理。\n',
    );
    process.exit(1);
  }
  process.stdout.write('✓ 仓库里没有未替换的真实 QQ 号\n');
  process.exit(0);
}

process.stdout.write(
  changed.length > 0
    ? `✓ 已替换 ${found.length} 处 / ${changed.length} 个文件\n`
    : '✓ 无需改动\n',
);
