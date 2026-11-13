/**
 * 签名审计的契约测试。
 *
 * 锁两件事：
 *   1. Linux 已实测的命令**不会**出现在 Linux 的待测清单里；
 *   2. Windows / macOS 因为证据都是推断的，清单非空 —— 这正是要给三端
 *      实测窗口的输入。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { auditSignRules, MEASURED_COMMANDS } from '../src/sign-audit';

test('Linux：已实测的命令不再出现在待测清单', () => {
  const measuredOnLinux = Object.entries(MEASURED_COMMANDS)
    .filter(([, platforms]) => platforms.includes('linux'))
    .map(([command]) => command);
  assert.ok(measuredOnLinux.length > 40, '实测记录太少，检查 MEASURED_COMMANDS');

  const pending = new Set(auditSignRules({ platform: 'linux' }).map((entry) => entry.command));
  for (const command of measuredOnLinux) {
    assert.ok(!pending.has(command), `${command} 已实测，不该再出现在清单里`);
  }
});

test('Windows / macOS：仍有大量推断结论待实测', () => {
  for (const platform of ['win32', 'darwin'] as const) {
    const entries = auditSignRules({ platform });
    assert.ok(entries.length > 20, `${platform} 待测清单异常地短（${entries.length}）`);

    // 三端实测还没做：要么是「完全未登记」（missing），要么是「从别的平台
    // 推断」（inferred）。两者都必须在本平台实测，所以清单非空是预期行为。
    const inferred = entries.filter((entry) => entry.priority === 'inferred');
    assert.ok(inferred.length > 20, `${platform} 的推断结论应该很多（实测尚未覆盖）`);
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

test('--commands 输出可喂给 probe-sign 的 cmd 形态', () => {
  const entries = auditSignRules({ platform: 'win32' });
  const oidb = entries.find((entry) => entry.command.startsWith('OidbSvcTrpcTcp.'));
  assert.ok(oidb);
  const bare = /^OidbSvcTrpcTcp\.(0x[0-9a-f]+_\d+)$/.exec(oidb.command);
  assert.ok(bare, `${oidb.command} 应能转成 probe-sign 的 --cmd 形态`);
});
