/**
 * 控制通道的 OneBot 管理面：`onebot.get` / `onebot.set`，以及 `attach` 与
 * `login` 的互斥。
 *
 * 这些用例直接打 `createControlHost`（不起 socket / 进程），因为它们验证的是
 * **协议语义**而不是传输：
 *
 *   - 配置形状与 `@weqbot/onebot` 对齐（四类网络）；
 *   - `accessToken` 读出打码、写回时按名字接回；
 *   - 端口冲突的错误能定位到具体 network；
 *   - attach 与 login 只能成功一个，且 attach 不写 vault。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { Bot, BotOneBotConfig, CreateBotOptions } from '@weqbot/bot';
import { TypedEventBus, WeqBotError } from '@weqbot/common';
import {
  controlRequest,
  type ControlEnvelope,
  type ControlFailure,
  type ControlOneBotConfig,
  type ControlOneBotState,
} from '@weqbot/control';
import type { BotEventMap, CredentialVault, StoredAccount } from '@weqbot/session';
import type { DeviceProfile, NativePort } from '@weqbot/wire';
import { createControlHost } from '../src/control-host';

const DEVICE: DeviceProfile = {
  os: 'linux',
  appId: 1600001615,
  subAppId: 537403759,
  qua: 'V1_LINUX_9.9.9',
  clientVersion: '9.9.9-1',
};

function memoryVault(): CredentialVault & { accounts: Map<string, StoredAccount> } {
  // 键是 `${group}:${uin}`：同一个 uin 的本机 / 自主凭据是两个身份，测试里也不能互相覆盖。
  const accounts = new Map<string, StoredAccount>();
  const keyOf = (uin: string, group: string) => `${group}:${uin}`;
  return {
    accounts,
    list: async (group) =>
      [...accounts.values()]
        .filter((item) => !group || item.group === group)
        .map((item) => ({ uin: item.uin, uid: item.uid, group: item.group })),
    get: async (uin, group = 'self') => accounts.get(keyOf(uin, group)),
    put: async (account) => {
      accounts.set(keyOf(account.uin, account.group), account);
    },
    delete: async (uin, group = 'self') => {
      accounts.delete(keyOf(uin, group));
    },
  };
}

function fakeBot(
  config: BotOneBotConfig | undefined,
  hooks: { reload?: (next?: BotOneBotConfig) => Promise<void> } = {},
): Bot {
  let current = config;
  return {
    uin: '10002',
    state: 'online',
    sessionId: 7,
    events: new TypedEventBus<BotEventMap>(),
    protocol: undefined,
    onebot: undefined,
    get onebotConfig() {
      return current;
    },
    snapshot: {
      uin: '10002',
      state: 'online',
      sessionId: 7,
      reconnects: 0,
      startedAt: Date.now(),
    },
    start: async () => {},
    stop: async () => {},
    refreshSecToken: async () => {},
    async reloadOneBot(next) {
      if (hooks.reload) await hooks.reload(next);
      current = next;
    },
  };
}

/** 走一遍 `host.handle` 并拿到 result / error。 */
async function call<P, R>(
  host: ReturnType<typeof createControlHost>,
  method: string,
  params: P,
): Promise<{ ok: true; result: R } | { ok: false; error: ControlFailure }> {
  let out: ControlEnvelope | undefined;
  await host.handle(controlRequest(1, method as never, params as never), (envelope) => {
    out = envelope;
  });
  assert.ok(out && out.kind === 'response');
  return out.ok
    ? { ok: true, result: out.result as R }
    : { ok: false, error: out.error as ControlFailure };
}

function emptyConfig(): ControlOneBotConfig {
  return { networks: { httpServers: [], httpClients: [], wsServers: [], wsClients: [] } };
}

test('onebot.get：未配置时给 false + null + 空 listeners', async () => {
  const host = createControlHost({
    uin: '10002',
    native: {} as NativePort,
    vault: memoryVault(),
  });
  const state = await call<Record<string, never>, ControlOneBotState>(host, 'onebot.get', {});
  assert.ok(state.ok);
  assert.equal(state.result.configured, false);
  assert.equal(state.result.config, null);
  assert.deepEqual(state.result.listeners, []);
});

test('onebot.set：上线前只记账，onebot.get 能读回', async () => {
  const host = createControlHost({
    uin: '10002',
    native: {} as NativePort,
    vault: memoryVault(),
  });
  const sent = emptyConfig();
  sent.networks.wsServers = [
    { name: 'client', port: 6700, messageFormat: 'array', reportSelfMessage: true },
  ];
  const applied = await call<{ config: ControlOneBotConfig }, ControlOneBotState>(
    host,
    'onebot.set',
    { config: sent },
  );
  assert.ok(applied.ok);
  assert.equal(applied.result.configured, true);
  assert.equal(applied.result.config?.networks.wsServers[0]?.port, 6700);
});

test('onebot.get 把 accessToken 打码；onebot.set 按名字接回原令牌', async () => {
  const host = createControlHost({
    uin: '10002',
    native: {} as NativePort,
    vault: memoryVault(),
  });
  const config = emptyConfig();
  config.networks.wsServers = [
    {
      name: 'client',
      port: 6700,
      messageFormat: 'array',
      reportSelfMessage: true,
      accessToken: 'secret-token',
    },
  ];
  await call(host, 'onebot.set', { config });

  // 读出来必须是打码的。
  const got = await call<Record<string, never>, ControlOneBotState>(host, 'onebot.get', {});
  assert.ok(got.ok);
  assert.equal(got.result.config?.networks.wsServers[0]?.accessToken, '***');

  // 页面把打码值写回来（同时改了端口）→ 令牌要接回去，不能变成字面量 '***'。
  const roundTrip = got.result.config!;
  roundTrip.networks.wsServers[0]!.port = 6701;
  const saved = await call<{ config: ControlOneBotConfig }, ControlOneBotState>(
    host,
    'onebot.set',
    { config: roundTrip },
  );
  assert.ok(saved.ok);
  assert.equal(saved.result.config?.networks.wsServers[0]?.accessToken, '***');
  assert.equal(saved.result.config?.networks.wsServers[0]?.port, 6701);
});

test('onebot.set：端口重复直接被拒，错误码可识别', async () => {
  const host = createControlHost({
    uin: '10002',
    native: {} as NativePort,
    vault: memoryVault(),
  });
  const config = emptyConfig();
  config.networks.wsServers = [
    { name: 'a', port: 6700, messageFormat: 'array', reportSelfMessage: true },
    { name: 'b', port: 6700, messageFormat: 'array', reportSelfMessage: true },
  ];
  const result = await call(host, 'onebot.set', { config });
  assert.ok(!result.ok);
  assert.equal(result.error.code, 'ONEBOT_LISTEN_FAILED');
  assert.match(result.error.message, /端口 6700/);
});

test('onebot.set：适配器起不来时透出 network / port，并保留旧配置', async () => {
  const previous: ControlOneBotConfig = emptyConfig();
  previous.networks.wsServers = [
    { name: 'old', port: 6700, messageFormat: 'array', reportSelfMessage: true },
  ];
  let calls = 0;
  const bot = fakeBot(previous as BotOneBotConfig, {
    reload: async (next) => {
      calls += 1;
      // 模拟 `reloadOneBot` 的回滚语义：抛错时 `bot.onebotConfig` 不动。
      if (next) {
        throw new WeqBotError('ONEBOT_LISTEN_FAILED', '端口 6701 已被占用（ws-server「new」）', {
          fields: { network: 'new', kind: 'ws-server', host: '127.0.0.1', port: 6701 },
        });
      }
    },
  });
  const host = createControlHost({
    uin: '10002',
    native: {} as NativePort,
    vault: memoryVault(),
    botFactory: () => bot,
  });
  // 先上线，让 bot 存在（entry 互斥不影响 onebot.set）。
  await call(host, 'attach', {
    pid: 1234,
    uin: '10002',
    uid: 'uid-1',
    guid: 'guid-1',
    a2: 'aa',
    d2: 'bb',
    d2Key: 'cc',
    subAppId: DEVICE.subAppId,
  });

  const target = emptyConfig();
  target.networks.wsServers = [
    { name: 'new', port: 6701, messageFormat: 'array', reportSelfMessage: true },
  ];
  const result = await call(host, 'onebot.set', { config: target });
  assert.ok(!result.ok);
  assert.equal(result.error.code, 'ONEBOT_LISTEN_FAILED');
  assert.deepEqual(result.error.details, {
    network: 'new',
    kind: 'ws-server',
    host: '127.0.0.1',
    port: 6701,
  });
  assert.equal(calls, 1);

  // 旧配置仍在（reloadOneBot 回滚）。
  const state = await call<Record<string, never>, ControlOneBotState>(host, 'onebot.get', {});
  assert.ok(state.ok);
  assert.equal(state.result.config?.networks.wsServers[0]?.name, 'old');
});

test('attach 不写 vault，且 uin 不一致直接拒绝', async () => {
  const vault = memoryVault();
  const created: CreateBotOptions[] = [];
  const host = createControlHost({
    uin: '10002',
    native: {} as NativePort,
    vault,
    botFactory: (options) => {
      created.push(options);
      return fakeBot(undefined);
    },
  });

  const mismatch = await call(host, 'attach', {
    pid: 1234,
    uin: '99999',
    uid: 'uid-1',
    guid: 'guid-1',
    a2: 'aa',
    d2: 'bb',
    d2Key: 'cc',
    subAppId: DEVICE.subAppId,
  });
  assert.ok(!mismatch.ok);
  assert.equal(mismatch.error.code, 'LOGIN_FAILED');
  assert.match(mismatch.error.message, /99999/);

  const ok = await call(host, 'attach', {
    pid: 1234,
    uin: '10002',
    uid: 'uid-1',
    guid: 'guid-1',
    a2: 'aa',
    d2: 'bb',
    d2Key: 'cc',
    subAppId: DEVICE.subAppId,
    device: DEVICE,
  });
  assert.ok(ok.ok);
  // 有头模式不碰 vault —— 会话物料只活在内存里。
  assert.equal(vault.accounts.size, 0);
  assert.equal(created[0]?.attach?.pid, 1234);
  assert.equal(created[0]?.attach?.uin, '10002');
  assert.equal(created[0]?.attach?.a2, 'aa');
});

test('attach 之后 login 被拒（两条凭据路径互斥）', async () => {
  const host = createControlHost({
    uin: '10002',
    native: {} as NativePort,
    vault: memoryVault(),
    botFactory: () => fakeBot(undefined),
  });
  await call(host, 'attach', {
    pid: 1234,
    uin: '10002',
    uid: 'uid-1',
    guid: 'guid-1',
    a2: 'aa',
    d2: 'bb',
    d2Key: 'cc',
    subAppId: DEVICE.subAppId,
  });
  const login = await call(host, 'login', {
    a1: '090807',
    guid: 'guid-1',
    uid: 'uid-1',
    device: DEVICE,
  });
  assert.ok(!login.ok);
  assert.equal(login.error.code, 'ALREADY_ONLINE');
});

test('login 之后 attach 被拒（反方向）', async () => {
  const host = createControlHost({
    uin: '10002',
    native: {} as NativePort,
    vault: memoryVault(),
    botFactory: () => {
      const bot = fakeBot(undefined);
      // 让 state 停在 online，模拟已上线。
      return bot;
    },
  });
  await call(host, 'login', {
    a1: '090807',
    guid: 'guid-1',
    uid: 'uid-1',
    device: DEVICE,
  });
  const attach = await call(host, 'attach', {
    pid: 1234,
    uin: '10002',
    uid: 'uid-1',
    guid: 'guid-1',
    a2: 'aa',
    d2: 'bb',
    d2Key: 'cc',
    subAppId: DEVICE.subAppId,
  });
  assert.ok(!attach.ok);
  assert.equal(attach.error.code, 'ALREADY_ONLINE');
});
