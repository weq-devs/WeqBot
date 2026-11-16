/**
 * 注册表 / Spotlight 探测。
 *
 * 分两层测：解析函数（纯字符串）在本机就能跑；`detectQqHints` 用注入的假
 * `run` 验证「查哪些 key、什么顺序、失败怎么降级」，全程不起子进程。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectQqHints,
  parseDefaultCommand,
  parseMdfindApp,
  parseUninstallString,
  type RunCommand,
} from '../src/webui/qq-detect';

// ─────────────────────────── parseUninstallString ───────────────────────────

test('parseUninstallString：带引号的值剥掉引号', () => {
  const stdout = [
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
    '    UninstallString    REG_SZ    "C:\\Program Files\\Tencent\\QQNT\\Uninstall.exe"',
    '',
  ].join('\r\n');
  assert.equal(parseUninstallString(stdout), 'C:\\Program Files\\Tencent\\QQNT\\Uninstall.exe');
});

test('parseUninstallString：不带引号、带参数也返回整串（调用方 dirname 后仍正确）', () => {
  const stdout = [
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
    '    UninstallString    REG_EXPAND_SZ    C:\\QQ\\Uninstall.exe /S',
  ].join('\r\n');
  const value = parseUninstallString(stdout);
  assert.equal(value, 'C:\\QQ\\Uninstall.exe /S');
});

test('parseUninstallString：多行噪声里只取 UninstallString 那行', () => {
  const stdout = [
    'HKEY_LOCAL_MACHINE\\...\\QQ',
    '    DisplayName    REG_SZ    腾讯QQ',
    '    DisplayVersion    REG_SZ    9.9.9',
    '    UninstallString    REG_SZ    "D:\\Apps\\QQNT\\Uninstall.exe"',
    '',
  ].join('\n');
  assert.equal(parseUninstallString(stdout), 'D:\\Apps\\QQNT\\Uninstall.exe');
});

test('parseUninstallString：没有这个值 / 空输出 → null', () => {
  assert.equal(parseUninstallString(''), null);
  assert.equal(
    parseUninstallString('HKEY_LOCAL_MACHINE\\...\n    DisplayName    REG_SZ    QQ\n'),
    null,
  );
});

// ─────────────────────────── parseDefaultCommand ───────────────────────────

test('parseDefaultCommand：取引号内的 exe，丢掉 "%1"', () => {
  const stdout = [
    'HKEY_CLASSES_ROOT\\tencent\\shell\\open\\command',
    '    (Default)    REG_SZ    "C:\\Program Files\\Tencent\\QQNT\\versions\\9.9.9\\resources\\app\\timwp.exe" "%1"',
    '',
  ].join('\r\n');
  assert.equal(
    parseDefaultCommand(stdout),
    'C:\\Program Files\\Tencent\\QQNT\\versions\\9.9.9\\resources\\app\\timwp.exe',
  );
});

test('parseDefaultCommand：中文系统里默认值叫「(默认)」', () => {
  const stdout = [
    'HKEY_CLASSES_ROOT\\tencent\\shell\\open\\command',
    '    (默认)    REG_SZ    "C:\\QQ\\timwp.exe" "%1"',
  ].join('\r\n');
  assert.equal(parseDefaultCommand(stdout), 'C:\\QQ\\timwp.exe');
});

test('parseDefaultCommand：没加引号的命令串取第一个 token', () => {
  const stdout = [
    'HKEY_CLASSES_ROOT\\tencent\\shell\\open\\command',
    '    (Default)    REG_SZ    C:\\QQ\\timwp.exe "%1"',
  ].join('\r\n');
  assert.equal(parseDefaultCommand(stdout), 'C:\\QQ\\timwp.exe');
});

test('parseDefaultCommand：空输出 / 只有 "%1" → null', () => {
  assert.equal(parseDefaultCommand(''), null);
  assert.equal(
    parseDefaultCommand('    (Default)    REG_SZ    "%1"\n'),
    null,
    '第一个 token 为空串时不算找到',
  );
});

// ─────────────────────────── parseMdfindApp ───────────────────────────

test('parseMdfindApp：多行取第一条非空', () => {
  assert.equal(
    parseMdfindApp('/Applications/QQ.app\n/Users/me/Applications/QQ.app\n'),
    '/Applications/QQ.app',
  );
});

test('parseMdfindApp：前后空行跳过；空输出 → null', () => {
  assert.equal(parseMdfindApp('\n\n  /Applications/QQ.app  \n'), '/Applications/QQ.app');
  assert.equal(parseMdfindApp(''), null);
  assert.equal(parseMdfindApp('\n\n'), null);
});

// ─────────────────────────── detectQqHints ───────────────────────────

interface Recorded {
  file: string;
  args: string[];
  timeoutMs: number;
}

/** 按 key 片段回放的假 run。 */
function fakeRun(responses: Array<{ match: string; stdout: string | null }>): {
  run: RunCommand;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const run: RunCommand = async (file, args, options) => {
    calls.push({ file, args, timeoutMs: options.timeoutMs });
    const joined = `${file} ${args.join(' ')}`;
    const hit = responses.find((item) => joined.includes(item.match));
    return hit ? hit.stdout : null;
  };
  return { run, calls };
}

test('detectQqHints：linux 不跑任何命令', async () => {
  const { run, calls } = fakeRun([]);
  const hints = await detectQqHints({ platform: 'linux', run });
  assert.equal(calls.length, 0);
  assert.equal(hints.installDir, null);
  assert.equal(hints.protocolExe, null);
  assert.equal(hints.spotlightApp, null);
  assert.deepEqual(hints.sources, {});
});

test('detectQqHints：win32 先查 tencent 协议，命中就不再试 mqqapi', async () => {
  const { run, calls } = fakeRun([
    {
      match: 'HKCR\\tencent\\shell\\open\\command',
      stdout:
        'HKEY_CLASSES_ROOT\\tencent\\shell\\open\\command\r\n    (Default)    REG_SZ    "C:\\QQ\\versions\\9.9.9\\resources\\app\\timwp.exe" "%1"\r\n',
    },
  ]);
  const hints = await detectQqHints({ platform: 'win32', run });

  assert.equal(hints.protocolExe, 'C:\\QQ\\versions\\9.9.9\\resources\\app\\timwp.exe');
  assert.equal(hints.sources.installDir, 'protocol');
  const protocolCalls = calls.filter((call) => call.args.join(' ').includes('HKCR\\'));
  assert.equal(protocolCalls.length, 1, 'tencent 命中后不该再查 mqqapi');
});

test('detectQqHints：tencent 查不到时降级到 mqqapi', async () => {
  const { run, calls } = fakeRun([
    {
      match: 'HKCR\\mqqapi\\shell\\open\\command',
      stdout:
        'HKEY_CLASSES_ROOT\\mqqapi\\shell\\open\\command\r\n    (Default)    REG_SZ    "C:\\QQ\\timwp.exe" "%1"\r\n',
    },
  ]);
  const hints = await detectQqHints({ platform: 'win32', run });

  assert.equal(hints.protocolExe, 'C:\\QQ\\timwp.exe');
  const protocols = calls
    .map((call) => call.args.join(' '))
    .filter((line) => line.includes('HKCR\\'))
    .map((line) => (line.includes('tencent') ? 'tencent' : 'mqqapi'));
  assert.deepEqual(protocols, ['tencent', 'mqqapi']);
});

test('detectQqHints：协议都没有时降级到注册表卸载项', async () => {
  const { run } = fakeRun([
    {
      match: 'Uninstall\\QQ',
      stdout:
        'HKEY_LOCAL_MACHINE\\...\\Uninstall\\QQ\r\n    UninstallString    REG_SZ    "C:\\Program Files\\Tencent\\QQNT\\Uninstall.exe"\r\n',
    },
  ]);
  const hints = await detectQqHints({ platform: 'win32', run });

  assert.equal(hints.protocolExe, null);
  assert.equal(hints.installDir, 'C:\\Program Files\\Tencent\\QQNT');
  assert.equal(hints.sources.installDir, 'registry');
});

test('detectQqHints：全都失败 → 全 null，不抛错', async () => {
  const { run } = fakeRun([]);
  const hints = await detectQqHints({ platform: 'win32', run });
  assert.deepEqual(hints, {
    installDir: null,
    protocolExe: null,
    spotlightApp: null,
    sources: {},
  });
});

test('detectQqHints：darwin 用 mdfind', async () => {
  const { run, calls } = fakeRun([{ match: 'mdfind', stdout: '/Applications/QQ.app\n' }]);
  const hints = await detectQqHints({ platform: 'darwin', run });

  assert.equal(hints.spotlightApp, '/Applications/QQ.app');
  assert.equal(hints.sources.installDir, 'spotlight');
  assert.equal(calls[0]?.file, 'mdfind');
});

test('detectQqHints：mdfind 失败（run 返回 null）时不抛错', async () => {
  const { run } = fakeRun([]);
  const hints = await detectQqHints({ platform: 'darwin', run });
  assert.equal(hints.spotlightApp, null);
  assert.deepEqual(hints.sources, {});
});

test('detectQqHints：超时按平台默认值传给 run（win32 1500 / darwin 3000）', async () => {
  const win = fakeRun([]);
  await detectQqHints({ platform: 'win32', run: win.run });
  assert.ok(win.calls.every((call) => call.timeoutMs === 1500));

  const mac = fakeRun([]);
  await detectQqHints({ platform: 'darwin', run: mac.run });
  assert.ok(mac.calls.every((call) => call.timeoutMs === 3000));
});
