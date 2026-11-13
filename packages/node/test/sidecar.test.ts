import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import type { Bot } from '@weqbot/bot';
import { TypedEventBus } from '@weqbot/common';
import { ControlLineDecoder, controlRequest, type ControlEnvelope } from '@weqbot/control';
import type { BotEventMap, CredentialVault, StoredAccount } from '@weqbot/session';
import type { NativePort } from '@weqbot/wire';
import { runSidecar } from '../src/sidecar';

const DEVICE = {
  os: 'linux' as const,
  appId: 1600001615,
  subAppId: 5371,
  qua: 'V1_LINUX_9.9.9',
  clientVersion: '9.9.9-1',
};

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
    uin: '2863253201',
    state: 'online',
    sessionId: 7,
    events: new TypedEventBus<BotEventMap>(),
    protocol: undefined,
    onebot: undefined,
    start: async () => {},
    stop: async () => {},
    refreshSecToken: async () => {},
  };
}

function harness() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const decoded: ControlEnvelope[] = [];
  const decoder = new ControlLineDecoder();
  stdout.on('data', (chunk: Uint8Array) => decoded.push(...decoder.push(chunk)));
  const exits: number[] = [];
  const vault = memoryVault();

  const handle = runSidecar({
    uin: '2863253201',
    native: {} as NativePort,
    vault,
    stdin,
    stdout,
    botFactory: () => fakeBot(),
    onExit: (code) => exits.push(code),
  });

  return { stdin, decoded, exits, vault, handle };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('等待超时');
}

test('ping / login / status / shutdown 全链路', async () => {
  const h = harness();
  h.stdin.write(`${JSON.stringify(controlRequest(1, 'ping', {}))}\n`);
  await waitFor(() => h.decoded.length >= 1);
  const ping = h.decoded[0];
  assert.ok(ping && ping.kind === 'response' && ping.ok);

  h.stdin.write(
    `${JSON.stringify(
      controlRequest(2, 'login', {
        a1: Buffer.from([9, 8, 7]).toString('base64'),
        guid: '0123456789abcdef0123456789abcdef',
        device: DEVICE,
      }),
    )}\n`,
  );
  await waitFor(() => h.decoded.length >= 2);
  const login = h.decoded[1];
  assert.ok(login && login.kind === 'response' && login.ok);
  assert.equal((login.result as { state: string }).state, 'online');
  assert.equal((login.result as { sessionId: number }).sessionId, 7);
  assert.deepEqual([...h.vault.accounts.get('2863253201')!.a1], [9, 8, 7]);

  h.stdin.write(`${JSON.stringify(controlRequest(3, 'status', {}))}\n`);
  await waitFor(() => h.decoded.length >= 3);
  const status = h.decoded[2];
  assert.ok(status && status.kind === 'response' && status.ok);

  h.stdin.write(`${JSON.stringify(controlRequest(4, 'shutdown', { reason: 'host-quit' }))}\n`);
  await waitFor(() => h.exits.length >= 1);
  const bye = h.decoded.find((envelope) => envelope.kind === 'event' && envelope.event === 'bye');
  assert.ok(bye && bye.kind === 'event');
  assert.deepEqual(bye.data, { reason: 'host-quit' });
  assert.deepEqual(h.exits, [0]);
});

test('stdin 关闭 = 宿主没了，sidecar 自己退出（V10）', async () => {
  const h = harness();
  h.stdin.end();
  await waitFor(() => h.exits.length >= 1);
  const bye = h.decoded.find((envelope) => envelope.kind === 'event' && envelope.event === 'bye');
  assert.ok(bye && bye.kind === 'event');
  assert.deepEqual(bye.data, { reason: 'parent-gone' });
});

test('login 缺少 device 时明确报错，不猜设备档案', async () => {
  const h = harness();
  h.stdin.write(
    `${JSON.stringify(
      controlRequest(1, 'login', {
        a1: Buffer.from([1]).toString('base64'),
        guid: '0123456789abcdef0123456789abcdef',
      }),
    )}\n`,
  );
  await waitFor(() => h.decoded.length >= 1);
  const response = h.decoded[0];
  assert.ok(response && response.kind === 'response');
  assert.equal(response.ok, false);
  assert.equal(response.error?.code, 'LOGIN_FAILED');
});
