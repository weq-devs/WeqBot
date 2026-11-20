/**
 * `startAccount` 交给 `createBot` 的配置。
 *
 * 这里锁住两条**曾在真机上踩过**的链路：
 *
 * 1. `wrapper.node` 必须从控制台的探测结果回填进 `config.native.wrapperPath`。
 *    不回填的后果是 Windows 上 mode 2 直接报 `SIGNER_REQUIRED` —— native 自己的
 *    `resolveQqWrapperPath` 只认 `resources\app\wrapper.node` 与
 *    `resources\app\versions\<ver>\`，而 QQ NT 的实际布局是
 *    `<qqRoot>\versions\<cur>\resources\app\`，层级正好相反。
 * 2. `qq.dbPath` 在用户没配时按账号目录推导，让 `isQqLoggedIn` 预检能跑。
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { BotConfig } from '@weqbot/bot';
import { createLogger, TypedEventBus, WeqBotError } from '@weqbot/common';
import type { AccountGroup, BotEventMap, CredentialVault, StoredAccount } from '@weqbot/session';
import type { LoginProgressEvent, RawNativeBinding } from '@weqbot/wire';
import { ConsoleRuntime } from '../src/webui/console';
import { HttpError } from '../src/webui/http-util';
import { Observability } from '../src/webui/observability';
import type { QqPaths } from '../src/webui/qq-paths';

const UID = 'u_LKt3AdAIMP-CUfn6ydzDzw';

function account(overrides: Partial<StoredAccount> = {}): StoredAccount {
  return {
    uin: '10002',
    uid: UID,
    a1: new Uint8Array([1, 2, 3]),
    guid: 'guid-guid-guid-guid-guid-guid-gu',
    group: 'local',
    device: {
      os: 'win32',
      appId: 1600001604,
      subAppId: 537403759,
      qua: 'V1_WIN_3.2.35_54395_GW_B',
      clientVersion: '3.2.35-54395',
    },
    a1Origin: 'login-db',
    ...overrides,
  } as StoredAccount;
}

function stubVault(stored: StoredAccount, deleted: string[] = []): CredentialVault {
  return {
    list: async (group?: AccountGroup) =>
      group && group !== stored.group
        ? []
        : [{ uin: stored.uin, uid: stored.uid, group: stored.group }],
    get: async (uin: string, group = 'self') =>
      uin === stored.uin && group === stored.group ? stored : undefined,
    put: async () => {},
    delete: async (uin: string, group = 'self') => {
      deleted.push(`${group}:${uin}`);
    },
  } as unknown as CredentialVault;
}

/** 采集 `botFactory` 收到的配置；`start()` 直接成功，除非传入 `startError`。 */
function makeRuntime(options: {
  paths: QqPaths;
  config?: Omit<BotConfig, 'account'>;
  stored?: StoredAccount;
  /** 让假 Bot 的 `start()` 抛这个错误（测失败分支）。 */
  startError?: unknown;
  /** 额外的 `login.db` 行（`source: 'login-db'` 分支）。 */
  rows?: Array<{
    uin: string;
    uid: string;
    a1Payload?: string | null;
    userName?: string;
    guid?: string | null;
  }>;
  /** 记下 vault.delete 的调用。 */
  deleted?: string[];
  /** 假 Bot 在 `start()` 期间推的登录进度（模拟 native 的异常设备确认）。 */
  loginProgress?: LoginProgressEvent[];
  /** 模拟 native 的 `updateLoginDbA1`；给了才在绑定上挂这个方法。 */
  updateA1?: (args: { dbPath: string; uin: string; payload: string }) => {
    updatedRows: number;
    verified: boolean;
    format: string;
  };
}) {
  const captured: Array<Parameters<typeof import('@weqbot/bot').createBot>[0]> = [];
  const decryptCalls = { count: 0 };
  const binding = {
    resolveAppidFromMajor: () => ({ appid: '537403759' }),
    testDatabaseKey: async () => ({
      success: true,
      pageHmacAlgorithm: 'sha1',
      kdfHmacAlgorithm: 'sha1',
    }),
    decryptLoginDb: () => {
      decryptCalls.count += 1;
      return options.rows ?? [];
    },
    ...(options.updateA1
      ? {
          updateLoginDbA1: (dbPath: string, uin: string, payload: string) => {
            const result = options.updateA1!({ dbPath, uin, payload });
            return { uin, dryRun: false, guid: 'a'.repeat(32), ...result };
          },
        }
      : {}),
  } as unknown as RawNativeBinding;
  const runtime = new ConsoleRuntime({
    native: {} as never,
    binding,
    vault: stubVault(options.stored ?? account(), options.deleted),
    config: options.config ?? {},
    logger: createLogger('test', { level: 'error' }),
    observability: new Observability(),
    discoverPaths: async () => options.paths,
    botFactory: ((botOptions: unknown) => {
      captured.push(botOptions as never);
      // `wireBot` 会给这些事件挂监听；给一份最小可用的假 Bot。
      // 事件总线是真的 `TypedEventBus`：进度事件的转发链路要能被测到。
      const events = new TypedEventBus<BotEventMap>();
      return {
        start: async () => {
          for (const event of options.loginProgress ?? []) {
            events.emit('login-progress', { type: 'login-progress', event, at: Date.now() });
          }
          if (options.startError !== undefined) throw options.startError;
        },
        stop: async () => {},
        events,
      } as never;
    }) as never,
  });
  return { runtime, captured, decryptCalls };
}

function pathsWith(patch: Partial<QqPaths> = {}): QqPaths {
  return {
    platform: 'win32',
    dataRoot: 'C:\\Tencent Files',
    loginDbs: [],
    qqExe: 'C:\\Program Files\\Tencent\\QQNT\\QQ.exe',
    installRoot: 'C:\\Program Files\\Tencent\\QQNT',
    appDir: 'C:\\Program Files\\Tencent\\QQNT\\versions\\9.9.9\\resources\\app',
    wrapperNode: 'C:\\Program Files\\Tencent\\QQNT\\versions\\9.9.9\\resources\\app\\wrapper.node',
    majorNode: 'C:\\Program Files\\Tencent\\QQNT\\versions\\9.9.9\\resources\\app\\major.node',
    version: '3.2.35-54395',
    sources: { qqExe: 'detected' },
    ...patch,
  };
}

test('startAccount 把探测到的 wrapper.node 回填进 config.native.wrapperPath', async () => {
  const paths = pathsWith();
  const { runtime, captured } = makeRuntime({ paths });

  await runtime.startAccount('10002');

  assert.equal(captured.length, 1);
  const config = captured[0]!.config;
  assert.equal(
    config.native?.wrapperPath,
    paths.wrapperNode,
    '不回填的话 Windows 上 createBot 会报 SIGNER_REQUIRED',
  );
});

test('startAccount 尊重用户手写的 native.wrapperPath（配置文件优先）', async () => {
  const locked = 'D:\\QQNT\\versions\\8.8.8\\resources\\app\\wrapper.node';
  const { runtime, captured } = makeRuntime({
    paths: pathsWith(),
    config: { native: { wrapperPath: locked } },
  });

  await runtime.startAccount('10002');

  assert.equal(captured[0]!.config.native?.wrapperPath, locked);
});

test('探测不到 wrapper 时不伪造，交给 createBot 按原逻辑报错', async () => {
  const { runtime, captured } = makeRuntime({ paths: pathsWith({ wrapperNode: null }) });

  await runtime.startAccount('10002');

  assert.equal(captured[0]!.config.native?.wrapperPath, undefined);
});

test('startAccount 从账号目录推导 qq.dbPath（没配 qq.dbPath 时）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weqbot-start-'));
  try {
    // unix 布局无法用真实 Windows 路径造，直接用 linux 平台驱动推导分支。
    const { accountDirName } = await import('../src/webui/qq-account');
    const accountDir = join(root, accountDirName(UID), 'nt_db');
    await mkdir(accountDir, { recursive: true });
    await writeFile(join(accountDir, 'nt_msg.db'), '');

    const { runtime, captured } = makeRuntime({
      paths: pathsWith({ platform: 'linux', dataRoot: root }),
    });

    await runtime.startAccount('10002');

    assert.equal(
      captured[0]!.config.qq?.dbPath,
      join(accountDir, 'nt_msg.db'),
      '推导出来的 dbPath 让 isQqLoggedIn 预检能跑',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('startAccount 里显式 qq.dbPath 优先于推导', async () => {
  const { runtime, captured } = makeRuntime({
    paths: pathsWith(),
    config: { qq: { dbPath: 'D:\\explicit\\nt_msg.db' } },
  });

  await runtime.startAccount('10002');

  assert.equal(captured[0]!.config.qq?.dbPath, 'D:\\explicit\\nt_msg.db');
});

test('startAccount 不把控制台专用的 qq.installDir / qq.dataDir 传给 bot', async () => {
  const { runtime, captured } = makeRuntime({
    paths: pathsWith(),
    config: { qq: { installDir: 'C:\\QQ', dataDir: 'C:\\Tencent Files' } },
  });

  await runtime.startAccount('10002');

  const qq = captured[0]!.config.qq as Record<string, unknown> | undefined;
  assert.equal(qq?.installDir, undefined);
  assert.equal(qq?.dataDir, undefined);
});

test('startAccount 遇到 A1_EXPIRED：删 vault、抛 409 A1_EXPIRED', async () => {
  const deleted: string[] = [];
  const { runtime } = makeRuntime({
    paths: pathsWith(),
    startError: new WeqBotError('A1_EXPIRED', 'a1 已失效'),
    deleted,
  });

  await assert.rejects(runtime.startAccount('10002'), (error: unknown) => {
    assert.ok(error instanceof HttpError, '必须转成 HttpError，否则 guard() 会吞成 500');
    assert.equal(error.status, 409);
    assert.equal(error.code, 'A1_EXPIRED');
    return true;
  });
  assert.deepEqual(
    deleted,
    ['local:10002'],
    '失效的凭据必须从 vault 删掉（且只删这一组），否则下次还拿它重试',
  );
});

test('startAccount 期间把登录进度转成 SSE 的 progress 字段', async () => {
  const { runtime } = makeRuntime({
    paths: pathsWith(),
    loginProgress: [
      { kind: 'state', state: 'key-exchange', message: '协商中' },
      { kind: 'unusual-device', message: '当前设备被判定为异常设备，请在手机上确认登录' },
    ],
  });
  const received: Array<{ phase?: string; progress?: LoginProgressEvent }> = [];
  runtime.consoleEvents.on('console', (event) =>
    received.push(event as { phase?: string; progress?: LoginProgressEvent }),
  );

  await runtime.startAccount('10002');

  const progresses = received.map((item) => item.progress).filter(Boolean);
  assert.equal(progresses.length, 2);
  assert.equal(progresses[1]!.kind, 'unusual-device');
  assert.match(progresses[1]!.message, /手机上确认/);
  // 进度事件不带 phase：页面靠 progress 字段识别，不能顺手改页面阶段。
  const progressEvents = received.filter((item) => item.progress);
  assert.ok(progressEvents.every((item) => item.phase === undefined));
});

test('startAccount 遇到其它 WeqBotError：4xx/5xx 带 code + message，不落成 INTERNAL', async () => {
  // `guard()` 对非 HttpError 一律 500 + INTERNAL，页面只会显示「内部错误」。
  // 登录阶段的所有预期失败都必须先转成 HttpError 再抛出去。
  const { runtime } = makeRuntime({
    paths: pathsWith(),
    startError: new WeqBotError('SIGNER_REQUIRED', '找不到 wrapper.node，mode 2 无法签名'),
  });

  await assert.rejects(runtime.startAccount('10002'), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.code, 'SIGNER_REQUIRED');
    assert.equal(error.message, '找不到 wrapper.node，mode 2 无法签名');
    assert.ok(error.status >= 400 && error.status < 600);
    return true;
  });
});

test('startAccount 遇到非 WeqBotError：仍给一句人话，不暴露原始异常', async () => {
  const { runtime } = makeRuntime({
    paths: pathsWith(),
    startError: new Error('EACCES: C:\\Users\\me\\credentials.json'),
  });

  await assert.rejects(runtime.startAccount('10002'), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.code, 'LOGIN_FAILED');
    assert.doesNotMatch(error.message, /EACCES|credentials\.json/);
    assert.match(error.message, /登录失败/);
    return true;
  });
});

test('自主组只读 vault，不碰 login.db', async () => {
  const { runtime, captured, decryptCalls } = makeRuntime({
    paths: pathsWith({ loginDbs: ['D:\\Tencent Files\\nt_qq\\global\\nt_db\\login.db'] }),
    stored: account({ group: 'self' }),
    rows: [{ uin: '10002', uid: UID, a1Payload: 'deadbeef', userName: '来自 login.db' }],
  });

  await runtime.startAccount('10002', { group: 'self' });

  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.config.account.uin, '10002');
  assert.equal(decryptCalls.count, 0, '自主组用自持凭据，不该去解密 login.db');
});

test('本机组用 login.db 的 a1，即使 vault 里也有', async () => {
  const { runtime, decryptCalls } = makeRuntime({
    paths: pathsWith({ loginDbs: ['D:\\Tencent Files\\nt_qq\\global\\nt_db\\login.db'] }),
    stored: account(),
    rows: [
      {
        uin: '10002',
        uid: UID,
        a1Payload: 'deadbeef',
        userName: '来自 login.db',
        guid: 'a'.repeat(32),
      },
    ],
  });

  // vault 里本来就有这个账号的本机镜像；本机组必须重新解 login.db，
  // 否则用户刚在 QQ 上刷新的 a1 会被 vault 里的旧值顶掉。
  await runtime.startAccount('10002', { group: 'local' });

  assert.ok(decryptCalls.count > 0, '必须真的去解 login.db');
});

test('自主组在 vault 里没有这个账号时明确报 NO_CREDENTIAL', async () => {
  const { runtime } = makeRuntime({ paths: pathsWith(), stored: account({ uin: '99999' }) });

  await assert.rejects(runtime.startAccount('10002', { group: 'self' }), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.code, 'NO_CREDENTIAL');
    return true;
  });
});

test('本机组上线后把轮换的 a1 写回 login.db', async () => {
  const calls: Array<{ dbPath: string; uin: string; payload: string }> = [];
  const loginDb = 'D:\\Tencent Files\\nt_qq\\global\\nt_db\\login.db';
  const { runtime } = makeRuntime({
    paths: pathsWith({ loginDbs: [loginDb] }),
    // 本机组用 login.db 的 a1（deadbeef）登录；createBot 轮换后把新值写进
    // vault，这里让 vault 里那份与入参不同，模拟「服务端换了 a1」。
    stored: account({ group: 'local', a1: new Uint8Array([9, 9, 9]) }),
    rows: [{ uin: '10002', uid: UID, a1Payload: 'deadbeef', guid: 'a'.repeat(32) }],
    updateA1: (args) => {
      calls.push(args);
      return { updatedRows: 1, verified: true, format: 'dpapi' };
    },
  });

  await runtime.startAccount('10002', { group: 'local' });

  assert.equal(calls.length, 1, '轮换过就必须回写，否则 QQ 本体那边一直是旧 a1');
  assert.equal(calls[0]!.dbPath, loginDb);
  assert.equal(calls[0]!.uin, '10002');
  assert.equal(calls[0]!.payload, '090909', '回写的是 vault 里的最新 a1，不是登录时用的旧值');
});

test('自主组不会把 a1 写回 login.db', async () => {
  const calls: unknown[] = [];
  const { runtime } = makeRuntime({
    paths: pathsWith({ loginDbs: ['D:\\Tencent Files\\nt_qq\\global\\nt_db\\login.db'] }),
    stored: account({ group: 'self', a1: new Uint8Array([9, 9, 9]) }),
    updateA1: (args) => {
      calls.push(args);
      return { updatedRows: 1, verified: true, format: 'guid-aes' };
    },
  });

  await runtime.startAccount('10002', { group: 'self' });

  assert.deepEqual(calls, [], '自主账号有自持 guid，写进 login.db 只会污染本机账号');
});
