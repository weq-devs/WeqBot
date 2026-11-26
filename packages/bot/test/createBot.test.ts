/**
 * `createBot` 的契约测试。
 *
 * 这里刻意不用真实 native：用一份假 `NativePort` 把 mode 2 的调用顺序、
 * session 物料拼装、sink 订阅/反订阅、失败分类固定下来。真实 native 的
 * 行为由 P2 的集成测试覆盖，两者不互相替代。
 */

import assert from 'node:assert/strict';
import { hostname, release } from 'node:os';
import test from 'node:test';
import { createLogger } from '@weqbot/common';
import {
  decode,
  encode,
  MSG_PUSH_CMD,
  MSG_PUSH_ENVELOPE,
  SEND_MESSAGE_REQUEST,
  SEND_MESSAGE_RESPONSE,
  SEND_MSG_CMD,
} from '@weqbot/protocol';
import type { CredentialVault, StoredAccount } from '@weqbot/session';
import type {
  DeviceProfile,
  NativePort,
  OpenSessionOptions,
  OpenedSession,
  PushFrame,
  QuickLoginOptions,
  QuickLoginResult,
  SessionInfo,
  SessionStatusEvent,
} from '@weqbot/wire';
import { createBot } from '../src/createBot';
import type { BotConfig } from '../src/config';

const DEVICE: DeviceProfile = {
  os: 'linux',
  appId: 537382819,
  subAppId: 537382819,
  qua: 'V1_LNX_NQ_3.2.35_53644_GW_B',
  clientVersion: '3.2.35-53644',
  deviceName: 'weqbot-test',
  kernelVersion: '6.0.0',
};

const ACCOUNT: StoredAccount = {
  uin: '10001',
  uid: 'u_test',
  a1: new Uint8Array([1, 2, 3, 4]),
  guid: 'a'.repeat(32),
  group: 'self',
  device: DEVICE,
};

// `syncGraceMs: 0`：测试断言的是「未同步就不上线」，不需要额外等 15s。
const CONFIG: BotConfig = { account: { uin: ACCOUNT.uin }, session: { syncGraceMs: 0 } };

/** 测试里不需要日志噪声；错误级别保留，失败时还能看到原因。 */
const SILENT = createLogger('test', { level: 'error' });

function makeVault(account: StoredAccount = ACCOUNT) {
  const saved: StoredAccount[] = [];
  const vault: CredentialVault = {
    list: async () => [{ uin: account.uin, uid: account.uid, group: account.group }],
    get: async (uin, group = account.group) =>
      uin === account.uin && group === account.group ? account : undefined,
    put: async (next) => {
      saved.push(next);
    },
    delete: async () => {},
  };
  return { vault, saved };
}

interface NativeHarness {
  native: NativePort;
  calls: {
    quickLogin: number;
    openSession: number;
    closeSession: number;
    pushSubscribed: number;
    pushUnsubscribed: number;
    statusSubscribed: number;
    statusUnsubscribed: number;
    lastOpen: OpenSessionOptions | undefined;
    lastQuickLogin: QuickLoginOptions | undefined;
    setSecToken: Array<{ sessionId: number; token: string }>;
  };
  emitPush(frame: PushFrame): void;
  emitPushError(error: Error): void;
  emitStatus(event: SessionStatusEvent): void;
}

function makeNative(overrides: Partial<NativePort> = {}): NativeHarness {
  const calls: NativeHarness['calls'] = {
    quickLogin: 0,
    openSession: 0,
    closeSession: 0,
    pushSubscribed: 0,
    pushUnsubscribed: 0,
    statusSubscribed: 0,
    statusUnsubscribed: 0,
    lastOpen: undefined,
    lastQuickLogin: undefined,
    setSecToken: [],
  };

  let pushSink: ((frame: PushFrame) => void) | undefined;
  let pushOnError: ((error: Error) => void) | undefined;
  let statusSink: ((event: SessionStatusEvent) => void) | undefined;

  const loginResult: QuickLoginResult = {
    uin: ACCOUNT.uin,
    uid: ACCOUNT.uid,
    a1: new Uint8Array([9, 9, 9]),
    a2: new Uint8Array([0xa2]),
    d2: new Uint8Array([0xd2]),
    d2Key: new Uint8Array(16).fill(7),
  };

  const opened: OpenedSession = {
    sessionId: 7,
    uin: ACCOUNT.uin,
    uid: ACCOUNT.uid,
    mode: 2,
    state: 'online',
    registered: true,
    synced: true,
  };

  const native: NativePort = {
    sendPacket: async () => new Uint8Array(),
    sendOidbPacket: async () => new Uint8Array(),
    quickLogin: async (options) => {
      calls.quickLogin += 1;
      calls.lastQuickLogin = options;
      return loginResult;
    },
    openSession: async (options) => {
      calls.openSession += 1;
      calls.lastOpen = options;
      return opened;
    },
    closeSession: async () => {
      calls.closeSession += 1;
    },
    getSession: async (): Promise<SessionInfo | null> => null,
    setSecToken: async (sessionId, token) => {
      calls.setSecToken.push({ sessionId, token });
      return true;
    },
    resolveWrapperPath: async () => '/tmp/wrapper.node',
    attachPushSink: async (_sessionId, sink, onError) => {
      calls.pushSubscribed += 1;
      pushSink = sink;
      pushOnError = onError;
      return () => {
        calls.pushUnsubscribed += 1;
        pushSink = undefined;
        pushOnError = undefined;
      };
    },
    attachStatusSink: async (_sessionId, sink) => {
      calls.statusSubscribed += 1;
      statusSink = sink;
      return () => {
        calls.statusUnsubscribed += 1;
        statusSink = undefined;
      };
    },
    ...overrides,
  };

  return {
    native,
    calls,
    emitPush: (frame) => pushSink?.(frame),
    emitPushError: (error) => pushOnError?.(error),
    emitStatus: (event) => statusSink?.(event),
  };
}

test('start: quickLogin → openSession(mode 2) → online', async () => {
  const { vault, saved } = makeVault();
  const harness = makeNative();
  const bot = createBot({ config: CONFIG, native: harness.native, vault, logger: SILENT });

  await bot.start();

  assert.equal(bot.state, 'online');
  assert.equal(harness.calls.quickLogin, 1);
  assert.equal(harness.calls.openSession, 1);
  assert.equal(harness.calls.lastOpen?.mode, 2);
  assert.equal(harness.calls.lastOpen?.session.uid, ACCOUNT.uid);
  assert.deepEqual(harness.calls.lastOpen?.session.a2, new Uint8Array([0xa2]));
  assert.equal(harness.calls.lastOpen?.session.guid, ACCOUNT.guid);
  assert.equal(harness.calls.lastOpen?.session.subAppId, DEVICE.subAppId);
  assert.equal(harness.calls.lastOpen?.device?.os, 'linux');
  assert.equal(harness.calls.lastOpen?.signer.wrapperPath, '/tmp/wrapper.node');
  assert.equal(harness.calls.lastOpen?.session.secToken?.length, 12);
  // 没配置 session.verifyFile 时不传这个键，让 native 用平台默认清单。
  assert.equal(harness.calls.lastOpen?.verifyFile, undefined);
  assert.equal(bot.protocol?.sessionId, 7);

  // quickLogin 轮换了 a1，应写回 vault。
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0]?.a1, new Uint8Array([9, 9, 9]));

  // 推送 / 状态 sink 都挂上了。
  assert.equal(harness.calls.pushSubscribed, 1);
  assert.equal(harness.calls.statusSubscribed, 1);

  await bot.stop('closed');
  assert.equal(bot.state, 'closed');
  assert.equal(harness.calls.closeSession, 1);
  assert.equal(harness.calls.pushUnsubscribed, 1);
  assert.equal(harness.calls.statusUnsubscribed, 1);
});

test('start: 有头模式（mode 1）即使配置了 verifyFile 也不上报', async () => {
  const { vault } = makeVault();
  const harness = makeNative({
    openSession: async (options) => {
      harness.calls.openSession += 1;
      harness.calls.lastOpen = options;
      return {
        sessionId: 9,
        uin: ACCOUNT.uin,
        uid: ACCOUNT.uid,
        mode: 1,
        state: 'open',
        registered: false,
        synced: false,
      };
    },
  });
  const bot = createBot({
    config: {
      ...CONFIG,
      session: {
        syncGraceMs: 0,
        verifyFile: { paths: ['/opt/QQ/qq'], fileMarks: ['1', '1', '1', '1'] },
      },
    },
    native: harness.native,
    vault,
    logger: SILENT,
    attach: {
      pid: 4242,
      uin: ACCOUNT.uin,
      uid: ACCOUNT.uid,
      guid: ACCOUNT.guid,
      a2: 'a2',
      d2: 'd2',
      d2Key: '00',
      subAppId: DEVICE.subAppId,
    },
  });

  await bot.start();
  assert.equal(harness.calls.lastOpen?.mode, 1);
  // 那条连接的在线状态与上报归 QQ 本体；我们再报一遍等于同设备两个客户端。
  assert.equal(harness.calls.lastOpen?.verifyFile, undefined);

  await bot.stop('closed');
});

test('start: session.verifyFile 原样透传给 openSession(mode 2)', async () => {
  const { vault } = makeVault();
  const harness = makeNative();
  const verifyFile = {
    paths: ['/opt/QQ/resources/app/background.js'],
    fileMarks: ['1', '1', '1', '1'],
    binaryPath: '/opt/QQ/qq',
    sendOnRegister: true,
  };
  const bot = createBot({
    config: { ...CONFIG, session: { syncGraceMs: 0, verifyFile } },
    native: harness.native,
    vault,
    logger: SILENT,
  });

  await bot.start();
  assert.deepEqual(harness.calls.lastOpen?.verifyFile, verifyFile);

  await bot.stop('closed');
});

test('start: 缺 openSession 能力时明确拒绝', async () => {
  const { vault } = makeVault();
  const harness = makeNative();
  delete harness.native.openSession;
  const bot = createBot({ config: CONFIG, native: harness.native, vault, logger: SILENT });

  await assert.rejects(bot.start(), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'NATIVE_MISSING_CAPABILITY');
    return true;
  });
  assert.equal(bot.state, 'preflight');
});

test('start: 登录与 vault 都没有 uid 时报 LOGIN_FAILED', async () => {
  const account = { ...ACCOUNT, uid: '' };
  const { vault } = makeVault(account);
  const harness = makeNative({
    quickLogin: async () => ({
      uin: ACCOUNT.uin,
      uid: '',
      a2: new Uint8Array([0xa2]),
      d2: new Uint8Array([0xd2]),
      d2Key: new Uint8Array(16),
    }),
  });
  const bot = createBot({ config: CONFIG, native: harness.native, vault, logger: SILENT });

  await assert.rejects(bot.start(), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'LOGIN_FAILED');
    return true;
  });
  assert.equal(harness.calls.openSession, 0);
});

test('start: 远端模式 exit 报 ACCESS_DENIED，且不误报成凭据问题', async () => {
  const { vault } = makeVault();
  const harness = makeNative({
    quickLogin: async () => {
      // native 侧 napi 错误只有 message，约定 LOGIN_DENIED: 前缀。
      throw new Error('LOGIN_DENIED: 远端模式下当前构建不允许登录');
    },
  });
  const bot = createBot({ config: CONFIG, native: harness.native, vault, logger: SILENT });

  await assert.rejects(bot.start(), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'ACCESS_DENIED');
    assert.match((error as Error).message, /项目策略/);
    assert.match((error as Error).message, /与 QQ 凭据无关/);
    return true;
  });
  assert.equal(harness.calls.openSession, 0);
});

test('start: quickLogin 返回 140022015 时报 A1_EXPIRED，不进 openSession', async () => {
  const { vault } = makeVault();
  const harness = makeNative({
    quickLogin: async () => {
      // 真机返回的 napi message 里带这个数字；文案是「你的用户身份已失效…」。
      throw new Error('140022015 你的用户身份已失效，为保证账号安全，请你重新登录');
    },
  });
  const bot = createBot({ config: CONFIG, native: harness.native, vault, logger: SILENT });

  await assert.rejects(bot.start(), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'A1_EXPIRED');
    return true;
  });
  assert.equal(harness.calls.openSession, 0);
});

test('start: quickLogin 返回 140022016（ILLEGAL_TICKET）同样报 A1_EXPIRED', async () => {
  // 真机日志：`err_code=140022016 title=登录失败 content=你的用户身份已失效…`。
  // 与 140022015 处置完全相同，只认 015 会让 WebUI 既不删凭据也不跳扫码。
  const { vault } = makeVault();
  const harness = makeNative({
    quickLogin: async () => {
      throw new Error(
        'EasyLogin 被拒绝：err_code=140022016 title=登录失败 content=你的用户身份已失效，为保证账号安全，请你重新登录。',
      );
    },
  });
  const bot = createBot({ config: CONFIG, native: harness.native, vault, logger: SILENT });

  await assert.rejects(bot.start(), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'A1_EXPIRED');
    // 诊断字段要留住命中的是哪个码。
    const fields = (error as { detail?: { fields?: Record<string, unknown> } }).detail?.fields;
    assert.equal(fields?.code, '140022016');
    return true;
  });
  assert.equal(harness.calls.openSession, 0);
});

test('start: 140022014（EXPIRE_TICKET）也归 A1_EXPIRED', async () => {
  const { vault } = makeVault();
  const harness = makeNative({
    quickLogin: async () => {
      throw new Error('EasyLogin 被拒绝：err_code=140022014 title=登录失败');
    },
  });
  const bot = createBot({ config: CONFIG, native: harness.native, vault, logger: SILENT });

  await assert.rejects(bot.start(), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'A1_EXPIRED');
    return true;
  });
});

test('start: 邻近码 140022017 不被误判成 a1 失效', async () => {
  const { vault } = makeVault();
  const harness = makeNative({
    quickLogin: async () => {
      // 边界正则的作用：只认完整的 140022015，别的码仍归 LOGIN_FAILED。
      throw new Error('140022017 其它登录错误');
    },
  });
  const bot = createBot({ config: CONFIG, native: harness.native, vault, logger: SILENT });

  await assert.rejects(bot.start(), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'LOGIN_FAILED');
    return true;
  });
});

test('start: quickLogin 的进度事件转成 login-progress（异常设备确认）', async () => {
  const { vault } = makeVault();
  const harness = makeNative({
    quickLogin: async (_options, onEvent) => {
      // native 的真实推送顺序：先阶段，再异常设备，最后才拿到票据。
      onEvent?.(null, { kind: 'state', state: 'key-exchange', message: '协商中' });
      onEvent?.(null, {
        kind: 'unusual-device',
        state: 'unusual-device',
        message: '当前设备被判定为异常设备，请确认',
        unusualDeviceCheckSig: Buffer.alloc(32),
      });
      return {
        uin: ACCOUNT.uin,
        uid: ACCOUNT.uid,
        a2: new Uint8Array([0xa2]),
        d2: new Uint8Array([0xd2]),
        d2Key: new Uint8Array(16),
      };
    },
  });
  const bot = createBot({ config: CONFIG, native: harness.native, vault, logger: SILENT });
  const seen: Array<{ kind: string; message: string }> = [];
  bot.events.on('login-progress', (event) =>
    seen.push({ kind: event.event.kind, message: event.event.message }),
  );

  await bot.start();

  assert.deepEqual(
    seen.map((item) => item.kind),
    ['state', 'unusual-device'],
  );
  assert.match(seen[1]!.message, /异常设备/);
});

test('start: 非 LOGIN_DENIED 的 native 错误仍归为 LOGIN_FAILED', async () => {
  const { vault } = makeVault();
  const harness = makeNative({
    quickLogin: async () => {
      throw new Error('a1 已被服务端拒绝');
    },
  });
  const bot = createBot({ config: CONFIG, native: harness.native, vault, logger: SILENT });

  await assert.rejects(bot.start(), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'LOGIN_FAILED');
    return true;
  });
});

test('配置了 onebot 时会启动适配器，stop 时一起关掉', async () => {
  const { vault } = makeVault();
  const harness = makeNative();
  const config: BotConfig = {
    ...CONFIG,
    onebot: {
      networks: { httpServers: [], httpClients: [], wsClients: [], wsServers: [] },
    },
  };
  const bot = createBot({ config, native: harness.native, vault, logger: SILENT });

  await bot.start();
  assert.ok(bot.onebot, 'onebot 适配器应已创建');
  // 没配任何网络时没有监听端口。
  assert.equal(bot.onebot?.port, undefined);
  // 后端只实现了协议覆盖的能力：发送 + 登录信息。
  assert.ok(bot.onebot?.actions().includes('send_group_msg'));

  await bot.stop('closed');
  assert.equal(bot.onebot, undefined);
});

test('OneBot send_msg 编码群聊字体，拒绝给私聊指定字体', async () => {
  const { vault } = makeVault();
  const sent: Uint8Array[] = [];
  const harness = makeNative({
    sendPacket: async (_sessionId, cmd, body) => {
      if (cmd !== SEND_MSG_CMD) return new Uint8Array();
      sent.push(body);
      return encode(SEND_MESSAGE_RESPONSE, { groupSequence: 11, privateSequence: 12 });
    },
  });
  const bot = createBot({
    config: {
      ...CONFIG,
      onebot: { networks: { httpServers: [], httpClients: [], wsClients: [], wsServers: [] } },
    },
    native: harness.native,
    vault,
    logger: SILENT,
  });

  await bot.start();
  try {
    const adapter = bot.onebot;
    assert.ok(adapter);
    const params = { message: '你好', font_id: 22045 };
    const cases = [
      { input: { ...params, group_id: 12345 }, retcode: 0 },
      { input: { ...params, user_id: 20001 }, retcode: 1400 },
      { input: { ...params, group_id: 12345, font_id: 65536 }, retcode: 1400 },
    ];
    for (const { input, retcode } of cases) {
      const result = await adapter.call('send_msg', input);
      assert.ok(result && typeof result === 'object' && 'retcode' in result);
      assert.equal(result.retcode, retcode);
    }
    assert.equal(sent.length, 1);
    const { messageBody } = decode(SEND_MESSAGE_REQUEST, sent[0]!) as {
      messageBody: {
        richText: { elems: { generalFlags?: { font: Record<string, unknown> } }[] };
      };
    };
    const font = messageBody.richText.elems[0]?.generalFlags?.font;
    assert.equal(font?.fontId1, 0);
    assert.equal(font?.fontId2, 0x11d56);
  } finally {
    await bot.stop('closed');
  }
});

test('start: QQ 本体在线时拒绝 mode 2', async () => {
  const { vault } = makeVault();
  const harness = makeNative({ isQqLoggedIn: async () => true });
  const config: BotConfig = { ...CONFIG, qq: { dbPath: '/tmp/nt_msg.db' } };
  const bot = createBot({ config, native: harness.native, vault, logger: SILENT });

  await assert.rejects(bot.start(), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'ALREADY_ONLINE');
    return true;
  });
  assert.equal(harness.calls.quickLogin, 0);
  assert.equal(harness.calls.openSession, 0);
});

test('设备档案缺 deviceName/kernelVersion 时用本机值补齐', async () => {
  const account: StoredAccount = {
    ...ACCOUNT,
    device: { ...DEVICE, deviceName: undefined, kernelVersion: undefined },
  };
  const { vault } = makeVault(account);
  const harness = makeNative();
  const bot = createBot({ config: CONFIG, native: harness.native, vault, logger: SILENT });

  await bot.start();

  assert.equal(harness.calls.lastQuickLogin?.deviceName, hostname());
  assert.equal(harness.calls.lastQuickLogin?.kernelVersion, release());
  await bot.stop('closed');
});

test('native 重连耗尽：直接下线为 relogin-failed，不再叠加 TS 重登', async () => {
  const { vault } = makeVault();
  const harness = makeNative();
  const bot = createBot({ config: CONFIG, native: harness.native, vault, logger: SILENT });
  const offlines: string[] = [];
  bot.events.on('offline', (event) => offlines.push(event.reason));

  await bot.start();
  harness.emitStatus({
    kind: 'closed',
    sessionId: 7,
    ts: Date.now(),
    reason: 'reconnect-failed',
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(bot.state, 'closed');
  assert.deepEqual(offlines, ['relogin-failed']);
  assert.equal(harness.calls.closeSession, 1);
});

test('重登时 a1 失效：不再退避重试，直接以 credential-expired 下线', async () => {
  const { vault } = makeVault();
  let attempts = 0;
  const harness = makeNative({
    quickLogin: async () => {
      attempts += 1;
      // 第一次成功上线，之后的重登发现 a1 已经过期。
      if (attempts > 1) throw new Error('140022015 你的用户身份已失效，请重新登录');
      return {
        uin: ACCOUNT.uin,
        uid: ACCOUNT.uid,
        a1: new Uint8Array([9, 9, 9]),
        a2: new Uint8Array([0xa2]),
        d2: new Uint8Array([0xd2]),
        d2Key: new Uint8Array(16).fill(7),
      };
    },
  });
  const bot = createBot({ config: CONFIG, native: harness.native, vault, logger: SILENT });
  const offlines: string[] = [];
  bot.events.on('offline', (event) => offlines.push(event.reason));

  await bot.start();
  // 模拟一次网络掉线，触发 `scheduleRelogin` 的 1s 退避。
  harness.emitStatus({ kind: 'closed', sessionId: 7, ts: Date.now(), reason: 'socket-closed' });
  await new Promise((resolve) => setTimeout(resolve, 1_400));

  assert.equal(bot.state, 'closed');
  assert.deepEqual(offlines, ['credential-expired']);
  assert.equal(attempts, 2, '失效后必须立刻停，不能把次数用满');
});

test('start: openSession 未完成首屏同步时拒绝上线', async () => {
  const { vault } = makeVault();
  const harness = makeNative({
    openSession: async () => ({
      sessionId: 8,
      uin: ACCOUNT.uin,
      uid: ACCOUNT.uid,
      mode: 2,
      state: 'open',
      registered: true,
      synced: false,
    }),
  });
  const bot = createBot({ config: CONFIG, native: harness.native, vault, logger: SILENT });

  await assert.rejects(bot.start(), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'REGISTER_FAILED');
    return true;
  });
  assert.notEqual(bot.state, 'online');
});

test('慢账号：首屏同步在宽限期内到达就继续上线', async () => {
  const { vault } = makeVault();
  let polls = 0;
  const harness = makeNative({
    openSession: async () => ({
      sessionId: 9,
      uin: ACCOUNT.uin,
      uid: ACCOUNT.uid,
      mode: 2,
      state: 'open',
      registered: true,
      synced: false,
    }),
    getSession: async () => {
      polls += 1;
      const synced = polls >= 2;
      return {
        sessionId: 9,
        uin: ACCOUNT.uin,
        uid: ACCOUNT.uid,
        mode: 2,
        state: synced ? 'online' : 'open',
        registered: true,
        synced,
        lastEventAt: null,
      };
    },
  });
  const bot = createBot({
    config: { account: { uin: ACCOUNT.uin }, session: { syncGraceMs: 3000 } },
    native: harness.native,
    vault,
    logger: SILENT,
  });

  await bot.start();
  assert.equal(bot.state, 'online');
  assert.ok(polls >= 2);
});

test('推送通道错误会变成 error 事件，不打断会话', async () => {
  const { vault } = makeVault();
  const harness = makeNative();
  const bot = createBot({ config: CONFIG, native: harness.native, vault, logger: SILENT });
  const errors: unknown[] = [];
  bot.events.on('event', (event) => {
    if (event.type === 'error') errors.push(event);
  });

  await bot.start();
  harness.emitPushError(new Error('sink broken'));

  assert.equal(errors.length, 1);
  assert.equal(bot.state, 'online');
  await bot.stop('closed');
});

test('心跳状态事件转发到 BotEvent', async () => {
  const { vault } = makeVault();
  const harness = makeNative();
  const bot = createBot({ config: CONFIG, native: harness.native, vault, logger: SILENT });
  const beats: number[] = [];
  bot.events.on('heartbeat', (event) => beats.push(event.at));

  await bot.start();
  harness.emitStatus({ kind: 'heartbeat', sessionId: 7, ts: 1234, rttMs: 12 });

  assert.deepEqual(beats, [1234]);
  await bot.stop('closed');
});

test('推送帧解码成 message 事件（含装扮）', async () => {
  const { vault } = makeVault();
  const harness = makeNative();
  const bot = createBot({ config: CONFIG, native: harness.native, vault, logger: SILENT });
  const received: unknown[] = [];
  bot.events.on('message', (message) => received.push(message));

  await bot.start();
  harness.emitPush({
    sessionId: 7,
    command: MSG_PUSH_CMD,
    seq: 1,
    ts: Date.now(),
    body: encode(MSG_PUSH_ENVELOPE, {
      messages: [
        {
          responseHead: {
            fromUin: 20002,
            fromUid: 'u_friend',
            grp: { groupUin: 55555, groupName: '测试群' },
          },
          contentHead: { msgType: 82, msgId: 88, sequence: 1, timestamp: 1_700_000_000 },
          body: {
            richText: { elems: [{ text: { str: 'hi' } }, { bubble: { id: 12 } }] },
          },
        },
      ],
    }),
  });

  assert.equal(received.length, 1);
  const message = received[0] as {
    peer: { id: string };
    elements: unknown[];
    dress: { bubble: number };
    random?: number;
  };
  assert.equal(message.peer.id, '55555');
  assert.deepEqual(message.elements, [{ kind: 'text', textContent: 'hi' }]);
  assert.equal(message.dress.bubble, 12);
  // contentHead.msgId 就是私聊撤回要的 random，不能丢在解码层。
  assert.equal(message.random, 88);

  await bot.stop('closed');
});

test('kicked 状态直接下线并报 kicked', async () => {
  const { vault } = makeVault();
  const harness = makeNative();
  const bot = createBot({ config: CONFIG, native: harness.native, vault, logger: SILENT });
  const offlines: string[] = [];
  bot.events.on('offline', (event) => offlines.push(event.reason));

  await bot.start();
  harness.emitStatus({ kind: 'kicked', sessionId: 7, ts: Date.now(), reason: 'KickNT' });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(bot.state, 'closed');
  assert.deepEqual(offlines, ['kicked']);
  assert.equal(harness.calls.closeSession, 1);
});

test('refreshSecToken: 原地换 token，不重新 openSession', async () => {
  const { vault } = makeVault();
  const harness = makeNative();
  const bot = createBot({ config: CONFIG, native: harness.native, vault, logger: SILENT });

  await bot.start();
  const opensBefore = harness.calls.openSession;
  await bot.refreshSecToken();

  assert.equal(harness.calls.setSecToken.length, 1);
  assert.equal(harness.calls.setSecToken[0]?.sessionId, 7);
  assert.match(harness.calls.setSecToken[0]?.token ?? '', /^[A-Za-z0-9]{12}$/);
  assert.equal(harness.calls.openSession, opensBefore);

  await bot.stop('closed');
});
