/**
 * 账号目录推导（`nt_msg.db` 定位）。
 *
 * `accountDirName` 的哈希规则来自 WeQ 的真机验证记录，**写死一个向量**防止后续
 * 重构改掉它 —— 一旦漂移，所有 unix 机器的在线预检都会静默失效（返回 null）。
 */

import assert from 'node:assert/strict';
import { join, win32 } from 'node:path';
import test from 'node:test';
import { accountDirName, findNtMsgDb } from '../src/webui/qq-account';

test('accountDirName：uid → nt_qq_<md5(md5(uid)+"nt_kernel")>', () => {
  // 真机记录（WeQ `packages/platform/src/linux/paths.ts:20`）：
  //   uid u_LKt3AdAIMP-CUfn6ydzDzw → nt_qq_2472b597…4186
  const name = accountDirName('u_LKt3AdAIMP-CUfn6ydzDzw');
  assert.match(name, /^nt_qq_[0-9a-f]{32}$/);
  // 真机记录只给了首尾（`nt_qq_2472b597…425e4186`），这里锁住完整值，
  // 规则一旦漂移（例如换了拼接顺序或编码）就会被这条断言挡住。
  assert.equal(
    name,
    'nt_qq_2472b5970cc3e5c0348c9601425e4186',
    '哈希规则发生变化会导致所有 unix 机器预检失效',
  );
});

test('findNtMsgDb：win32 用 <root>/<uin>/nt_qq/nt_db/nt_msg.db', () => {
  const root = 'C:\\Tencent Files';
  const dbPath = win32.join(root, '10002', 'nt_qq', 'nt_db', 'nt_msg.db');
  const found = findNtMsgDb({
    platform: 'win32',
    dataRoot: root,
    uin: '10002',
    exists: (path) => path === dbPath,
  });
  assert.equal(found, dbPath);
});

test('findNtMsgDb：win32 没有 uin 时返回 null', () => {
  assert.equal(
    findNtMsgDb({ platform: 'win32', dataRoot: 'C:\\Tencent Files', exists: () => true }),
    null,
  );
});

test('findNtMsgDb：win32 的 uin 必须是纯数字', () => {
  assert.equal(
    findNtMsgDb({
      platform: 'win32',
      dataRoot: 'C:\\Tencent Files',
      uin: 'u_abc',
      exists: () => true,
    }),
    null,
  );
});

test('findNtMsgDb：unix 用 <root>/nt_qq_<hash>/nt_db/nt_msg.db', () => {
  const root = '/home/me/.config/QQ';
  const dbPath = join(root, accountDirName('u_LKt3AdAIMP-CUfn6ydzDzw'), 'nt_db', 'nt_msg.db');
  const found = findNtMsgDb({
    platform: 'linux',
    dataRoot: root,
    uid: 'u_LKt3AdAIMP-CUfn6ydzDzw',
    exists: (path) => path === dbPath,
  });
  assert.equal(found, dbPath);
});

test('findNtMsgDb：unix 没有 uid 时返回 null（推不出目录就不猜）', () => {
  assert.equal(
    findNtMsgDb({ platform: 'linux', dataRoot: '/home/me/.config/QQ', exists: () => true }),
    null,
  );
});

test('findNtMsgDb：文件不存在时返回 null，而不是一个假路径', () => {
  assert.equal(
    findNtMsgDb({
      platform: 'linux',
      dataRoot: '/home/me/.config/QQ',
      uid: 'u_LKt3AdAIMP-CUfn6ydzDzw',
      exists: () => false,
    }),
    null,
  );
});

test('findNtMsgDb：dataRoot 为 null 时直接返回 null', () => {
  assert.equal(
    findNtMsgDb({ platform: 'linux', dataRoot: null, uid: 'u_x', exists: () => true }),
    null,
  );
});
