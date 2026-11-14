/**
 * 签名审计的契约测试。
 *
 * 锁三件事：
 *   1. 任一平台已实测的命令**不会**再出现在该平台的待测清单里；
 *   2. 每个平台都还有推断结论待实测 —— 三端实测尚未完成，清单非空是预期；
 *   3. 2026-11-14 补测的那批 Windows / macOS 命令已从清单里消失。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { auditSignRules, MEASURED_COMMANDS } from '../src/sign-audit';

test('已实测的命令不再出现在对应平台的待测清单', () => {
  const measuredOnLinux = Object.entries(MEASURED_COMMANDS)
    .filter(([, platforms]) => platforms.includes('linux'))
    .map(([command]) => command);
  assert.ok(measuredOnLinux.length > 40, '实测记录太少，检查 MEASURED_COMMANDS');

  const pending = new Set(auditSignRules({ platform: 'linux' }).map((entry) => entry.command));
  for (const command of measuredOnLinux) {
    assert.ok(!pending.has(command), `${command} 已实测，不该再出现在清单里`);
  }
});

test('每个平台都仍有推断结论待实测', () => {
  for (const platform of ['linux', 'win32', 'darwin'] as const) {
    const entries = auditSignRules({ platform });
    assert.ok(entries.length > 20, `${platform} 待测清单异常地短（${entries.length}）`);

    // 三端实测都还没做全：清单里要么是「完全未登记」（missing），要么是
    // 「从别的平台推断」（inferred）。两者都必须在本平台实测。
    const inferred = entries.filter((entry) => entry.priority === 'inferred');
    assert.ok(inferred.length > 20, `${platform} 的推断结论应该很多（实测尚未覆盖）`);
  }
});

test('2026-11-14 补测的 Windows / macOS 命令已移出待测清单', () => {
  const measuredOnWindows = Object.entries(MEASURED_COMMANDS)
    .filter(([, platforms]) => platforms.includes('win32'))
    .map(([command]) => command);
  assert.ok(measuredOnWindows.length >= 20, 'Windows 实测记录少于 20 条，检查 MEASURED_COMMANDS');

  for (const platform of ['win32', 'darwin'] as const) {
    const pending = new Set(auditSignRules({ platform }).map((entry) => entry.command));
    for (const command of measuredOnWindows) {
      // 只对确实在该平台测过的命令断言。
      if (!MEASURED_COMMANDS[command]!.includes(platform)) continue;
      assert.ok(!pending.has(command), `${command} 已在 ${platform} 实测，不该再出现在清单里`);
    }
  }
});

test('未登记命令优先于推断结论', () => {
  const entries = auditSignRules({ platform: 'linux' });
  const firstInferred = entries.findIndex((entry) => entry.priority === 'inferred');
  const lastMissing = entries.map((entry) => entry.priority).lastIndexOf('missing');
  if (firstInferred >= 0 && lastMissing >= 0) {
    assert.ok(lastMissing < firstInferred, 'missing 应排在 inferred 之前');
  }
});

test('--commands 输出的 OIDB 命令能转成裸 cmd 形态', () => {
  const entries = auditSignRules({ platform: 'win32' });
  const oidb = entries.find((entry) => entry.command.startsWith('OidbSvcTrpcTcp.'));
  assert.ok(oidb);
  const bare = /^OidbSvcTrpcTcp\.(0x[0-9a-f]+_\d+)$/.exec(oidb.command);
  assert.ok(bare, `${oidb.command} 应能转成裸 cmd 形态`);
});
