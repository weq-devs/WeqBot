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
import { encode, MSG_PUSH_CMD, MSG_PUSH_ENVELOPE } from '@weqbot/protocol';
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
  device: DEVICE,
};

const CONFIG: BotConfig = { account: { uin: ACCOUNT.uin } };

/** 测试里不需要日志噪声；错误级别保留，失败时还能看到原因。 */
const SILENT = createLogger('test', { level: 'error' });

function makeVault(account: StoredAccount = ACCOUNT) {
  const saved: StoredAccount[] = [];
  const vault: CredentialVault = {
    list: async () => [{ uin: account.uin, uid: account.uid }],
    get: async (uin) => (uin === account.uin ? account : undefined),
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
  };
  assert.equal(message.peer.id, '55555');
  assert.deepEqual(message.elements, [{ kind: 'text', textContent: 'hi' }]);
  assert.equal(message.dress.bubble, 12);

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
