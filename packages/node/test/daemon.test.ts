/** `--serve` 常驻 daemon：客户端断开不退出、多客户端、shutdown 收摊。 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Bot } from '@weqbot/bot';
import { TypedEventBus } from '@weqbot/common';
import { connectControlSocket, type ControlEnvelope } from '@weqbot/control';
import type { BotEventMap, CredentialVault, StoredAccount } from '@weqbot/session';
import type { NativePort } from '@weqbot/wire';
import { runDaemon } from '../src/daemon';

const DEVICE = {
  os: 'linux' as const,
  appId: 1600001615,
  subAppId: 537403759,
  qua: 'V1_LINUX_9.9.9',
  clientVersion: '9.9.9-1',
};

const unixOnly = process.platform === 'win32' ? 'unix socket 专属' : false;

function memoryVault(): CredentialVault & { accounts: Map<string, StoredAccount> } {
  const accounts = new Map<string, StoredAccount>();
  return {
    accounts,
    list: async () => [...accounts.values()].map((a) => ({ uin: a.uin, uid: a.uid })),
    get: async (uin) => accounts.get(uin),
    put: async (account) => {
      accounts.set(account.uin, account);
    },
    delete: async (uin) => {
      accounts.delete(uin);
    },
  };
}

function fakeBot(): Bot {
  return {
    uin: '10002',
    state: 'online',
    sessionId: 7,
    events: new TypedEventBus<BotEventMap>(),
    protocol: undefined,
    onebot: undefined,
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
    reloadOneBot: async () => {},
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('等待超时');
}

test('daemon：客户端断开后继续跑，事件广播给所有连接', { skip: unixOnly }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'weqbot-daemon-'));
  const socketPath = join(dir, 'control.sock');
  const exits: number[] = [];
  const bots: Bot[] = [];
  const vault = memoryVault();

  const daemon = await runDaemon({
    uin: '10002',
    native: {} as NativePort,
    vault,
    socketPath,
    botFactory: () => {
      const bot = fakeBot();
      bots.push(bot);
      return bot;
    },
    onExit: (code) => exits.push(code),
  });

  const first = await connectControlSocket({ path: socketPath });
  const second = await connectControlSocket({ path: socketPath });

  try {
    const ping = await first.request('ping', {});
    assert.ok(ping.pid > 0);
    assert.equal(daemon.clients(), 2);

    // 未登录时状态是 idle，且 device 还是空的。
    assert.equal((await second.request('status', {})).state, 'idle');

    const login = await first.request('login', {
      a1: '090807',
      guid: 'guid-1',
      uid: 'uid-1',
      device: DEVICE,
    });
    assert.equal(login.state, 'online');
    assert.equal(login.sessionId, 7);
    assert.deepEqual([...(vault.accounts.get('10002')?.a1 ?? [])], [9, 8, 7]);

    // 第二条连接也看得到同一次登录的结果。
    assert.equal((await second.request('status', {})).state, 'online');

    // 广播：两条连接都要收到。
    const events: ControlEnvelope[][] = [[], []];
    first.on((envelope) => events[0]!.push(envelope));
    second.on((envelope) => events[1]!.push(envelope));
    bots[0]!.events.emit('heartbeat', { at: Date.now(), kind: 'pong' } as never);
    await waitFor(() => events[0]!.length === 1 && events[1]!.length === 1);
    assert.equal(events[0]![0]?.kind, 'event');
    assert.equal(events[1]![0]?.kind, 'event');

    // 分水岭：客户端全走了，daemon 和它的 bot 都不动。
    first.close();
    second.close();
    await waitFor(() => daemon.clients() === 0);
    assert.deepEqual(exits, []);

    const third = await connectControlSocket({ path: socketPath });
    assert.equal((await third.request('status', {})).state, 'online');
    third.close();
  } finally {
    first.close();
    second.close();
    await daemon.close('test-done');
    await rm(dir, { recursive: true, force: true });
  }

  assert.deepEqual(exits, [0]);
  assert.equal(existsSync(socketPath), false);
});

test('daemon：shutdown 广播 bye 后退出，且只退一次', { skip: unixOnly }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'weqbot-daemon-'));
  const socketPath = join(dir, 'control.sock');
  const exits: number[] = [];
  const daemon = await runDaemon({
    uin: '10002',
    native: {} as NativePort,
    vault: memoryVault(),
    socketPath,
    botFactory: () => fakeBot(),
    onExit: (code) => exits.push(code),
  });
  const client = await connectControlSocket({ path: socketPath });
  const seen: ControlEnvelope[] = [];
  client.on((envelope) => seen.push(envelope));

  try {
    await client.request('shutdown', { reason: 'host-quit' });
    await waitFor(() => exits.length === 1);
    const bye = seen.find((envelope) => envelope.kind === 'event' && envelope.event === 'bye') as
      | { data?: { reason?: string } }
      | undefined;
    assert.deepEqual(bye?.data, { reason: 'host-quit' });

    // 幂等：再关一次不会再触发 onExit。
    await daemon.close('again');
    await waitFor(() => !existsSync(socketPath));
    assert.deepEqual(exits, [0]);
  } finally {
    client.close();
    await daemon.close('cleanup');
    await rm(dir, { recursive: true, force: true });
  }
});

test('daemon：login 缺少 device 明确报错，且不留下半个账号', { skip: unixOnly }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'weqbot-daemon-'));
  const socketPath = join(dir, 'control.sock');
  const vault = memoryVault();
  const daemon = await runDaemon({
    uin: '10002',
    native: {} as NativePort,
    vault,
    socketPath,
    botFactory: () => fakeBot(),
    onExit: () => {},
  });
  const client = await connectControlSocket({ path: socketPath });

  try {
    await assert.rejects(client.request('login', { a1: '090807', guid: 'g' }), (error: Error) => {
      assert.equal((error as { code?: string }).code, 'LOGIN_FAILED');
      assert.match(error.message, /device/);
      return true;
    });
    assert.equal(vault.accounts.size, 0);
    assert.equal((await client.request('status', {})).state, 'idle');
  } finally {
    client.close();
    await daemon.close('cleanup');
    await rm(dir, { recursive: true, force: true });
  }
});
