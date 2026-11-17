/**
 * 有头模式的进程层逻辑：提权阶梯、实例过滤、物料校验。
 *
 * 全部用假 binding / 注入的 `runElevated`，**不附加任何真实进程**：真机附加需要
 * root 且会改 QQ 的调试状态，不该出现在测试里。这里验的是「什么时候该提权、
 * 提权失败怎么表达、扫到的东西够不够开一个会话」。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createLogger } from '@weqbot/common';
import type { RawNativeBinding } from '@weqbot/wire';
import {
  AttachError,
  isPermissionError,
  listQqInstances,
  looksLikeQqProcess,
  scanSessionMaterial,
} from '../src/webui/attach';

const logger = createLogger('test');

/** 一个权限错误的形状（与内核 EPERM 的真机文案一致）。 */
function eperm(): Error {
  return new Error('operation not permitted (os error 1)');
}

const GOOD_MATERIAL = {
  a2: 'aa'.repeat(4),
  d2: 'bb'.repeat(4),
  d2Key: 'cc'.repeat(16),
  secToken: 'Tok3n/base64',
};

function bindingWith(
  scan: RawNativeBinding['scanSessionMaterial'],
  extra: Partial<RawNativeBinding> = {},
): RawNativeBinding {
  return { scanSessionMaterial: scan, ...extra };
}

test('进程名判定：只认 QQ 本身，子进程与其它程序不算', () => {
  assert.equal(looksLikeQqProcess('QQ.exe'), true);
  assert.equal(looksLikeQqProcess('qq'), true);
  assert.equal(looksLikeQqProcess(' QQ '), true);
  assert.equal(looksLikeQqProcess('QQHelper.exe'), false);
  assert.equal(looksLikeQqProcess('weqbot'), false);
  assert.equal(looksLikeQqProcess(''), false);
});

test('权限错误判定：提权能修的才算，进程没了不算', () => {
  assert.equal(isPermissionError(eperm()), true);
  assert.equal(isPermissionError(new Error('不允许的操作 (os error 1)')), true);
  assert.equal(isPermissionError(new Error('EPERM: operation not permitted')), true);
  assert.equal(isPermissionError(new Error('No such process (os error 3)')), false);
  assert.equal(isPermissionError(new Error('wrapper.node 未映射')), false);
});

test('实例列表：按 wrapper.node 找进程，名字不对的丢弃，模块路径带回来', () => {
  const binding = bindingWith(undefined, {
    listProcessesWithModule: (hint) => {
      assert.equal(hint, 'wrapper.node');
      return [
        { pid: 10, ppid: 1, name: 'QQ.exe', cmdline: '', modules: [] },
        { pid: 11, ppid: 10, name: 'QQHelper.exe', cmdline: '', modules: [] },
        { pid: 12, ppid: 10, name: 'qq', cmdline: '', modules: [] },
        // 同一个 pid 出现两次（不同模块命中）不该出两条。
        { pid: 12, ppid: 10, name: 'qq', cmdline: '', modules: [] },
      ];
    },
    resolveQqRuntimeModules: (pid) =>
      pid === 10 ? { wrapperPath: '/qq/wrapper.node', majorPath: '/qq/major.node' } : null,
  });

  const instances = listQqInstances(binding);
  assert.deepEqual(
    instances.map((item) => item.pid),
    [10, 12],
  );
  assert.equal(instances[0]?.wrapperPath, '/qq/wrapper.node');
  // 拿不到运行中的模块时仍然保留进程：能不能接入由上层再判。
  assert.equal(instances[1]?.wrapperPath, undefined);
});

test('实例列表：旧构建没有探测能力时返回空数组而不是抛错', () => {
  assert.deepEqual(listQqInstances({}), []);
});

test('本进程能读就直接返回，不提权', async () => {
  let elevatedCalls = 0;
  const material = await scanSessionMaterial({
    binding: bindingWith(async () => GOOD_MATERIAL),
    logger,
    pid: process.pid,
    runElevated: async () => {
      elevatedCalls += 1;
      return GOOD_MATERIAL;
    },
  });
  assert.equal(material.a2, GOOD_MATERIAL.a2);
  assert.equal(elevatedCalls, 0);
});

test('权限被拒且没有密码 → ELEVATION_REQUIRED（页面据此弹提权框）', async () => {
  await assert.rejects(
    scanSessionMaterial({
      binding: bindingWith(async () => {
        throw eperm();
      }),
      logger,
      pid: process.pid,
      // 明确「sudo 凭据不在缓存里」：否则真机上会去 fork 一个 sudo 探测。
      sudoCached: async () => false,
    }),
    (cause: unknown) => cause instanceof AttachError && cause.code === 'ELEVATION_REQUIRED',
  );
});

test('权限被拒但 sudo 已缓存 → 空密码也能提权（不白让用户再输一次）', async () => {
  let sawPassword: string | undefined;
  const material = await scanSessionMaterial({
    binding: bindingWith(async () => {
      throw eperm();
    }),
    logger,
    pid: process.pid,
    sudoCached: async () => true,
    runElevated: async (request) => {
      sawPassword = request.password;
      return GOOD_MATERIAL;
    },
  });
  assert.equal(sawPassword, '');
  assert.equal(material.d2Key, GOOD_MATERIAL.d2Key);
});

test('用户给了密码 → 直接走提权，不再探测 sudo', async () => {
  let probed = false;
  const material = await scanSessionMaterial({
    binding: bindingWith(async () => {
      throw eperm();
    }),
    logger,
    pid: process.pid,
    password: 'hunter2',
    sudoCached: async () => {
      probed = true;
      return false;
    },
    runElevated: async (request) => {
      assert.equal(request.password, 'hunter2');
      return GOOD_MATERIAL;
    },
  });
  assert.equal(probed, false);
  assert.equal(material.a2, GOOD_MATERIAL.a2);
});

test('物料不全 → NO_SESSION_MATERIAL（QQ 还没登录完 / 结构变了）', async () => {
  await assert.rejects(
    scanSessionMaterial({
      binding: bindingWith(async () => ({ d2: 'bb' })),
      logger,
      pid: process.pid,
    }),
    (cause: unknown) => cause instanceof AttachError && cause.code === 'NO_SESSION_MATERIAL',
  );
});

test('native 报进程不存在 → PROCESS_GONE（提权修不好，不弹密码框）', async () => {
  await assert.rejects(
    scanSessionMaterial({
      binding: bindingWith(async () => {
        throw new Error('No such process (os error 3)');
      }),
      logger,
      pid: process.pid,
      sudoCached: async () => true,
    }),
    (cause: unknown) => cause instanceof AttachError && cause.code === 'PROCESS_GONE',
  );
});

test('pid 已经不在 → PROCESS_GONE，且不会白弹一次提权框', {
  skip: process.platform !== 'linux',
}, async () => {
  let reachedNative = false;
  await assert.rejects(
    scanSessionMaterial({
      binding: bindingWith(async () => {
        reachedNative = true;
        return GOOD_MATERIAL;
      }),
      logger,
      pid: 4_194_303,
      sudoCached: async () => true,
    }),
    (cause: unknown) => cause instanceof AttachError && cause.code === 'PROCESS_GONE',
  );
  // 必须先检查活体：否则死 pid 会先被当成权限问题拉去提权。
  assert.equal(reachedNative, false);
});

test('原生组件没有 scanSessionMaterial → NATIVE_MISSING_CAPABILITY', async () => {
  await assert.rejects(
    scanSessionMaterial({ binding: {}, logger, pid: 42 }),
    (cause: unknown) => cause instanceof AttachError && cause.code === 'NATIVE_MISSING_CAPABILITY',
  );
});
