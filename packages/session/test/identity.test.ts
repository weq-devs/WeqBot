import assert from 'node:assert/strict';
import test from 'node:test';
import { IdentityCache } from '../src/identity';

test('uid ↔ uin 双向观测', () => {
  const cache = new IdentityCache();
  cache.observe('u_abc', 10001);
  assert.equal(cache.uinOf('u_abc'), '10001');
  assert.equal(cache.uidOf('10001'), 'u_abc');
  assert.equal(cache.uidOf(10001), 'u_abc');
  assert.equal(cache.size, 1);
});

test('非法 uid / uin 不写入', () => {
  const cache = new IdentityCache();
  cache.observe('not-a-uid', 10001);
  cache.observe('u_abc', 12);
  cache.observe('u_abc', 'abc');
  cache.observe('', 10001);
  assert.equal(cache.size, 0);
});

test('同一 uid 改了 uin：反向表不会留下旧映射', () => {
  const cache = new IdentityCache();
  cache.observe('u_abc', 10001);
  cache.observe('u_abc', 20002);
  assert.equal(cache.uinOf('u_abc'), '20002');
  assert.equal(cache.uidOf('10001'), undefined);
  assert.equal(cache.uidOf('20002'), 'u_abc');
});

test('有界：超过容量淘汰最老观测', () => {
  const cache = new IdentityCache(2);
  cache.observe('u_1', 10001);
  cache.observe('u_2', 10002);
  cache.observe('u_3', 10003);
  assert.equal(cache.size, 2);
  assert.equal(cache.uinOf('u_1'), undefined);
  assert.equal(cache.uinOf('u_3'), '10003');
});
