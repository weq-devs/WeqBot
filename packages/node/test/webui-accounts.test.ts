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
function makeRuntime(options: { vault: AccountSummary[]; rows: LoginRow[] }) {
  const binding = {
    testDatabaseKey: async () => ({
      success: true,
      pageHmacAlgorithm: 'sha1',
      kdfHmacAlgorithm: 'sha1',
    }),
    decryptLoginDb: () => options.rows,
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

test('vault 与 login.db 都有时合并成一个条目，昵称来自 login.db', async () => {
  const runtime = makeRuntime({
    vault: [{ uin: '10001', uid: 'u_both' }],
    rows: [{ uin: '10001', uid: 'u_both', a1Payload: 'abc', userName: '冬眠的猫' }],
  });

  const accounts = await runtime.accounts();

  assert.equal(accounts.length, 1);
  assert.equal(accounts[0]?.nickname, '冬眠的猫');
});

test('login.db 行没有 a1 但 vault 有凭据时照常列出', async () => {
  const runtime = makeRuntime({
    vault: [{ uin: '10001', uid: 'u_both' }],
    rows: [{ uin: '10001', uid: 'u_both', a1Payload: null, userName: '冬眠的猫' }],
  });

  const accounts = await runtime.accounts();

  assert.deepEqual(
    accounts.map((item) => item.uin),
    ['10001'],
  );
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
