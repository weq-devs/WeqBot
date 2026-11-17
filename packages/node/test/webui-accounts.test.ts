/**
 * `accounts()` 的口径：**只列能直接上线的账号**。
 *
 * 没有 a1 的行不出现在列表里 —— 点进去必然 `NO_CREDENTIAL`，做成可点条目只会
 * 让用户白跑一趟。这条规则在前后端各有一半（服务端过滤 + 前端不再展示「无 a1」
 * 徽标），所以锁在后端这一侧。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createLogger } from '@weqbot/common';
import type { AccountSummary, CredentialVault } from '@weqbot/session';
import type { RawNativeBinding } from '@weqbot/wire';
import { ConsoleRuntime } from '../src/webui/console';
import { Observability } from '../src/webui/observability';
import type { QqPaths } from '../src/webui/qq-paths';

interface LoginRow {
  uin: string;
  uid: string;
  a1Payload?: string | null;
  userName?: string;
}

/**
 * 造一个「vault 有 N 条、login.db 解出 M 行」的运行时。
 *
 * `decryptLoginDb` 的签名是同步的，`testDatabaseKey` 是 async —— 与真实绑定一致。
 */
function makeRuntime(options: {
  vault: AccountSummary[];
  rows: LoginRow[];
  /** 显式 `qq.dbPath`：推不出账号目录时，在线状态探测走这一份。 */
  qqDbPath?: string;
  /** 模拟 `probeDbLock` 的持有者；不给就不带这个能力。 */
  holders?: Array<{ pid: number; name: string }>;
}) {
  const binding = {
    testDatabaseKey: async () => ({
      success: true,
      pageHmacAlgorithm: 'sha1',
      kdfHmacAlgorithm: 'sha1',
    }),
    decryptLoginDb: () => options.rows,
    ...(options.holders
      ? {
          probeDbLock: () => ({
            success: true,
            msg: '',
            locked: options.holders!.length > 0,
            holders: options.holders,
          }),
        }
      : {}),
  } as unknown as RawNativeBinding;

  const vault = {
    list: async () => options.vault,
    get: async () => undefined,
    put: async () => {},
    delete: async () => {},
  } as unknown as CredentialVault;

  const paths: QqPaths = {
    platform: 'linux',
    dataRoot: '/data/QQ',
    loginDbs: ['/data/QQ/global/nt_db/login.db'],
    qqExe: null,
    installRoot: null,
    appDir: null,
    wrapperNode: null,
    majorNode: null,
    version: null,
    sources: {},
  };

  return new ConsoleRuntime({
    native: {} as never,
    binding,
    vault,
    config: {},
    logger: createLogger('test', { level: 'error' }),
    observability: new Observability(),
    discoverPaths: async () => paths,
    ...(options.qqDbPath ? { qqDbPath: options.qqDbPath } : {}),
  });
}

test('login.db 里没有 a1 的行不出现在账号列表里', async () => {
  const runtime = makeRuntime({
    vault: [],
    rows: [
      { uin: '10001', uid: 'u_with_a1', a1Payload: 'deadbeef', userName: '有凭据' },
      { uin: '10002', uid: 'u_no_a1', a1Payload: null, userName: '没有凭据' },
      { uin: '10003', uid: 'u_undefined', userName: '字段缺失' },
    ],
  });

  const accounts = await runtime.accounts();

  assert.deepEqual(
    accounts.map((item) => item.uin),
    ['10001'],
    '没有 a1 的账号点进去必然失败，不该出现在「点一下就能登录」的列表里',
  );
});

test('vault 里的账号一定在列表里（vault 保证有 a1）', async () => {
  const runtime = makeRuntime({
    vault: [{ uin: '20001', uid: 'u_vault', lastOnlineAt: 1_700_000_000_000 }],
    rows: [],
  });

  const accounts = await runtime.accounts();

  assert.deepEqual(
    accounts.map((item) => item.uin),
    ['20001'],
  );
  assert.equal(accounts[0]?.lastLoginAt, 1_700_000_000_000);
});

test('vault 与 login.db 都有时列出两条，来源不同且不合并', async () => {
  const runtime = makeRuntime({
    vault: [{ uin: '10001', uid: 'u_both' }],
    rows: [{ uin: '10001', uid: 'u_both', a1Payload: 'abc', userName: '冬眠的猫' }],
  });

  const accounts = await runtime.accounts();

  assert.equal(accounts.length, 2, '两个来源语义不同，页面要分开列');
  assert.deepEqual(accounts.map((item) => item.source).sort(), ['login-db', 'vault']);
  // 昵称只来自 login.db 那一行（vault 不存昵称）。
  assert.equal(accounts.find((item) => item.source === 'login-db')?.nickname, '冬眠的猫');
  assert.equal(accounts.find((item) => item.source === 'vault')?.nickname, undefined);
});

test('login.db 行没有 a1 但 vault 有凭据时只列出 vault 那条', async () => {
  const runtime = makeRuntime({
    vault: [{ uin: '10001', uid: 'u_both' }],
    rows: [{ uin: '10001', uid: 'u_both', a1Payload: null, userName: '冬眠的猫' }],
  });

  const accounts = await runtime.accounts();

  assert.deepEqual(
    accounts.map((item) => `${item.source}:${item.uin}`),
    ['vault:10001'],
  );
});

test('login.db 行没有 a1 且 vault 也没有时不出现', async () => {
  const runtime = makeRuntime({
    vault: [],
    rows: [{ uin: '10003', uid: 'u_no_a1', a1Payload: null, userName: '没有凭据' }],
  });

  const accounts = await runtime.accounts();

  assert.deepEqual(accounts, []);
});

test('账号列表带 QQ 本体在线状态，且只认进程名像 QQ 的持有者', async () => {
  const runtime = makeRuntime({
    vault: [{ uin: '10001', uid: 'u_a' }],
    rows: [],
    qqDbPath: '/data/QQ/nt_db/nt_msg.db',
    // WeQ / WeqBot 自己也会持有这个库；按名字过滤才不会把登录页的徽标点错。
    holders: [
      { pid: 12, name: 'weqbot' },
      { pid: 34, name: 'QQ.exe' },
    ],
  });

  const accounts = await runtime.accounts();

  assert.equal(accounts[0]?.qqOnline, true, 'QQ 正在用这个账号，页面要能警告');
});

test('只有非 QQ 进程持有 nt_msg.db 时不算「QQ 本体在线」', async () => {
  const runtime = makeRuntime({
    vault: [{ uin: '10001', uid: 'u_a' }],
    rows: [],
    qqDbPath: '/data/QQ/nt_db/nt_msg.db',
    holders: [{ pid: 12, name: 'WeQ' }],
  });

  const accounts = await runtime.accounts();

  assert.equal(accounts[0]?.qqOnline, false);
});

test('探测不到在线状态时不发 qqOnline（不用 false 冒充结论）', async () => {
  const runtime = makeRuntime({ vault: [{ uin: '10001', uid: 'u_a' }], rows: [] });

  const accounts = await runtime.accounts();

  assert.equal('qqOnline' in (accounts[0] as object), false);
});

test('列表不暴露 a1 或它的存在性字段', async () => {
  const runtime = makeRuntime({
    vault: [],
    rows: [{ uin: '10001', uid: 'u_x', a1Payload: 'secret-payload' }],
  });

  const accounts = await runtime.accounts();

  assert.equal(accounts.length, 1);
  const serialized = JSON.stringify(accounts);
  assert.ok(!serialized.includes('secret-payload'), 'a1 原文绝不能进响应');
  assert.ok(
    !('hasA1' in (accounts[0] as object)),
    'a1 的存在性是服务端过滤条件，不是要发给页面的字段',
  );
});
