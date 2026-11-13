#!/usr/bin/env -S node --import tsx
/**
 * 打印当前平台需要实测签名的命令清单。
 *
 * 用法：
 *   pnpm sign:audit                            # 当前平台
 *   pnpm sign:audit --platform win32
 *   pnpm sign:audit --json                     # 机器可读
 *   pnpm sign:audit --commands                 # 只输出命令名（喂给 probe-sign）
 *
 * 为什么是这个脚本：`SIGN_RULES` 的策略带平台语义，但「哪些结论是真机实测、
 * 哪些是从别的平台推断」表本身表达不出来。Windows / macOS 拉代码后不该靠翻
 * git log 猜 —— 跑这个脚本即可。
 *
 * 依赖 tsx：仓库里的源码是 `.ts` 且用相对 import 不带扩展名。
 */

import { auditSignRules, formatSignAudit } from '../packages/protocol/src/sign-audit.ts';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const platform = option('--platform') ?? process.platform;
const entries = auditSignRules({ platform });

if (args.includes('--json')) {
  process.stdout.write(
    `${JSON.stringify(
      entries.map((entry) => ({
        command: entry.command,
        priority: entry.priority,
        needsSign: entry.needsSign ?? null,
      })),
      null,
      2,
    )}\n`,
  );
} else if (args.includes('--commands')) {
  // 直接给 probe-sign 用：`--cmd` 需要裸的 `0xXXXX_N` 形式。
  for (const entry of entries) {
    const match = /^OidbSvcTrpcTcp\.(0x[0-9a-f]+_\d+)$/.exec(entry.command);
    process.stdout.write(`${match ? match[1] : entry.command}\n`);
  }
} else {
  process.stdout.write(`${formatSignAudit(entries, platform)}\n`);
}
