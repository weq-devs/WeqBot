#!/usr/bin/env -S node --import tsx
/**
 * 生成 `schema/onebot-actions.json` —— 文档站消费的 OneBot action 快照。
 *
 * 用法：
 *
 *   pnpm docs:actions           # 写盘
 *   pnpm docs:actions --check   # 只校验，不写盘（CI 用）
 *
 * 为什么快照提交在主仓而不是文档仓：文档站是独立仓库，读不到 `@weqbot/onebot`
 * 的源码；把快照放在主仓，改 action 和改文档数据就是同一个 PR 的两行，漂移在
 * `test/actions-snapshot.test.ts` 里直接红灯。放在文档仓则变成「改代码 → 记得去
 * submodule 更新 → 回主仓提交 gitlink」的三步同步，漏一步没人发现。
 *
 * 输出是**稳定排序 + 固定缩进**的，这样 diff 只反映真实变化。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildActionsSnapshot } from '../packages/onebot/src/docs/snapshot.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const target = join(root, 'schema', 'onebot-actions.json');
const checkOnly = process.argv.includes('--check');

const snapshot = buildActionsSnapshot();
const text = `${JSON.stringify(snapshot, null, 2)}\n`;

if (checkOnly) {
  let current;
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    process.stderr.write(`✖ 找不到 ${target}，先跑 \`pnpm docs:actions\`\n`);
    process.exit(1);
  }
  if (current !== text) {
    process.stderr.write(
      '✖ schema/onebot-actions.json 与代码不一致。\n' +
        '  改了 action 的 summary / description / inputSchema 后要重跑 `pnpm docs:actions`。\n',
    );
    process.exit(1);
  }
  process.stdout.write('✓ OneBot 文档快照是最新的\n');
  process.exit(0);
}

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, text);
const { actions, groups, withParams } = snapshot.totals;
process.stdout.write(
  `✓ 已写入 ${target}\n` +
    `  ${groups} 组 / ${actions} 条 action（${withParams} 条有入参；` +
    `${snapshot.deniedActions.length} 条敏感能力不注册）\n`,
);
