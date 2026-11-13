/**
 * 签名登记覆盖率。
 *
 * 规则：`resolveSign` 查不到命令时会按「不签名」发包并打 warn —— 这条对
 * 新搬入的协议极其危险（静默错签不会报错，只在运行期表现为「服务端拒绝」）。
 * 所以这里扫一遍所有 spec 的 `command/subCommand`，要求每条都已登记
 * （`SIGN_RULES` 或 `UNCONFIRMED_SIGN_COMMANDS`）。
 *
 * 发现新命令没登记时：先用 `scripts/probe-sign.ts` 真机实测，再决定
 * 写 `{ sign: ... }` 还是进 `UNCONFIRMED_SIGN_COMMANDS`。**不要**为了
 * 让测试变绿随便填 `none`。
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { SIGN_RULES, UNCONFIRMED_SIGN_COMMANDS, oidbCommand } from '../src/sign-policy';

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

interface SpecCommand {
  file: string;
  wire: string;
}

/** 从源码里抽 `export const command = 0xXXXX` + 同名的 `subCommand`。 */
function collectSpecCommands(root: string): SpecCommand[] {
  const found: SpecCommand[] = [];
  for (const file of walk(root)) {
    if (file.endsWith('/index.ts') || file.endsWith('sign-policy.ts')) continue;
    const source = readFileSync(file, 'utf8');
    if (!source.includes('export const command = ')) continue;

    const command = /export const command = (0x[0-9a-fA-F]+)/.exec(source);
    if (!command) continue;
    // 动态子命令（0x9082 / 0xf90）由 resolveSubCommand 决定，静态 `subCommand`
    // 要么不存在、要么属于同文件里的另一个 namespace（0xf90 与 0x9474 同文件，
    // 拼出来会得到从未存在的 `0xf90_0`）。这类命令各自按 sub 显式登记，跳过。
    if (source.includes('export const resolveSubCommand')) continue;
    const subCommand = /export const subCommand = (\d+)/.exec(source);
    if (!subCommand) continue;

    found.push({
      file: file.replace(root, ''),
      wire: oidbCommand(Number.parseInt(command[1]!, 16), Number.parseInt(subCommand[1]!, 10)),
    });
  }
  return found;
}

test('所有 OIDB spec 的签名都已登记', () => {
  const specs = collectSpecCommands(join(import.meta.dirname, '..', 'src'));
  assert.ok(specs.length > 20, `只找到 ${specs.length} 个 spec，路径可能不对`);

  const missing = specs.filter(
    ({ wire }) =>
      !Object.hasOwn(SIGN_RULES, wire) && !Object.hasOwn(UNCONFIRMED_SIGN_COMMANDS, wire),
  );

  assert.deepEqual(
    missing,
    [],
    `以下命令既不在 SIGN_RULES 也不在 UNCONFIRMED_SIGN_COMMANDS，请先用 probe-sign 实测：\n${missing
      .map((entry) => `  ${entry.wire} (${entry.file})`)
      .join('\n')}`,
  );
});
