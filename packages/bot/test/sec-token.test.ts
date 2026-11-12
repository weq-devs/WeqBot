/**
 * `SecToken` 形态测试。
 *
 * 真机逆向结论：12 字符、`[A-Za-z0-9]`、每次登录重新生成。这里只锁形态，
 * 不试图证明随机性（那是 CSPRNG 的职责）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { generateSecToken } from '../src/sec-token';

test('默认生成 12 个 [A-Za-z0-9] 字符', () => {
  for (let i = 0; i < 100; i += 1) {
    const token = generateSecToken();
    assert.match(token, /^[A-Za-z0-9]{12}$/);
    assert.ok(!token.includes('+'));
    assert.ok(!token.includes('/'));
  }
});

test('可注入随机源，且拒绝会造成取模偏置的字节', () => {
  let calls = 0;
  const random = (size: number): Uint8Array => {
    calls += 1;
    // 第一轮全部是 255（>= 248，必须丢弃），第二轮全部是 0（映射到 'A'）。
    return new Uint8Array(size).fill(calls === 1 ? 255 : 0);
  };

  const token = generateSecToken(random);
  assert.equal(token, 'AAAAAAAAAAAA');
  assert.equal(calls, 2);
});

test('注入的字节按字母表映射', () => {
  const random = (size: number): Uint8Array =>
    Uint8Array.from({ length: size }, (_, index) => index);
  const token = generateSecToken(random);
  assert.equal(token, 'ABCDEFGHIJKL');
});
