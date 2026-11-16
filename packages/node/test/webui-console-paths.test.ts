/**
 * `ConsoleRuntime` 的路径缓存行为。
 *
 * 只测「什么时候重新探测」这一件事 —— 用计数版的 `discoverPaths` 注入，断言调用
 * 次数，不碰真实磁盘与 native。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createLogger } from '@weqbot/common';
import type { CredentialVault } from '@weqbot/session';
import type { RawNativeBinding } from '@weqbot/wire';
import { ConsoleRuntime } from '../src/webui/console';
import { Observability } from '../src/webui/observability';
import type { QqPaths } from '../src/webui/qq-paths';

function stubPaths(tag: string): QqPaths {
  return {
    platform: 'linux',
    dataRoot: `/data/${tag}`,
    loginDbs: [],
    qqExe: null,
    installRoot: null,
    appDir: null,
    wrapperNode: null,
    majorNode: null,
    version: null,
    sources: {},
  };
}

function stubVault(): CredentialVault {
  return {
    list: async () => [],
    get: async () => undefined,
    put: async () => {},
    delete: async () => {},
  } as unknown as CredentialVault;
}

function stubBinding(): RawNativeBinding {
  // 路径测试不需要任何进程层能力：全部留空，`environment()` 会跳过对应分支。
  return {} as RawNativeBinding;
}

function makeRuntime(options: { ttlMs?: number } = {}) {
  const calls: string[] = [];
  const runtime = new ConsoleRuntime({
    native: {} as never,
    binding: stubBinding(),
    vault: stubVault(),
    config: {},
    logger: createLogger('test', { level: 'error' }),
    observability: new Observability(),
    discoverPaths: async () => {
      const tag = `run-${calls.length + 1}`;
      calls.push(tag);
      return stubPaths(tag);
    },
    ...(options.ttlMs === undefined ? {} : { qqPathsTtlMs: options.ttlMs }),
  });
  return { runtime, calls };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('TTL 内重复调用 environment() 只探测一次', async () => {
  const { runtime, calls } = makeRuntime({ ttlMs: 60_000 });
  await runtime.environment();
  await runtime.environment();
  await runtime.environment();
  assert.equal(calls.length, 1);
});

test('TTL 过期后重新探测', async () => {
  const { runtime, calls } = makeRuntime({ ttlMs: 20 });
  await runtime.environment();
  await sleep(30);
  await runtime.environment();
  assert.equal(calls.length, 2);
});

test('environment(refresh: true) 跳过 TTL 立即重算', async () => {
  const { runtime, calls } = makeRuntime({ ttlMs: 60_000 });
  await runtime.environment();
  await runtime.environment(true);
  assert.equal(calls.length, 2);
});

test('invalidateQqPaths() 立即作废缓存', async () => {
  const { runtime, calls } = makeRuntime({ ttlMs: 60_000 });
  await runtime.environment();
  runtime.invalidateQqPaths();
  await runtime.environment();
  assert.equal(calls.length, 2);
});

test('并发调用只触发一次探测（单飞）', async () => {
  const { runtime, calls } = makeRuntime({ ttlMs: 60_000 });
  await Promise.all([runtime.environment(), runtime.environment(), runtime.environment()]);
  assert.equal(calls.length, 1);
});

test('探测结果确实被回填到 environment()', async () => {
  const { runtime } = makeRuntime({ ttlMs: 60_000 });
  const environment = await runtime.environment();
  assert.equal(environment.dataRoot, '/data/run-1');
});

test('setQqPathOverrides() 写入覆盖并让缓存失效', async () => {
  const { runtime, calls } = makeRuntime({ ttlMs: 60_000 });
  await runtime.environment();
  assert.equal(runtime.qqPathOverrides, null);

  runtime.setQqPathOverrides({ installDir: '/opt/QQ', dataDir: null });
  assert.deepEqual(runtime.qqPathOverrides, { installDir: '/opt/QQ', dataDir: null });

  await runtime.environment();
  assert.equal(calls.length, 2, '覆盖变化必须触发重新探测');
});

test('setQqPathOverrides(null) 清除覆盖', async () => {
  const { runtime } = makeRuntime({ ttlMs: 60_000 });
  runtime.setQqPathOverrides({ installDir: '/opt/QQ' });
  runtime.setQqPathOverrides(null);
  assert.equal(runtime.qqPathOverrides, null);
});
