/**
 * WebUI 访问令牌与会话（W2）。
 *
 * 锁定时长 / 剩余次数 / 常量时间比较的行为都在这里钉死；HTTP 层见
 * `webui-server.test.ts`。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  generateToken,
  LOCK_MS,
  looksLikeToken,
  MAX_ATTEMPTS,
  sessionCookie,
  WebUiAuth,
} from '../src/webui/auth';

test('令牌是 wqb_ + 24 位 base62，且每次不同', () => {
  const a = generateToken();
  const b = generateToken();
  assert.match(a, /^wqb_[0-9A-Za-z]{24}$/);
  assert.notEqual(a, b);
  assert.equal(looksLikeToken(a), true);
  assert.equal(looksLikeToken('wqb_short'), false);
  assert.equal(looksLikeToken('nope'), false);
});

test('正确令牌换到会话；错误令牌返回剩余次数', () => {
  const auth = new WebUiAuth('wqb_AAAAAAAAAAAAAAAAAAAAAAAA');
  const bad = auth.createSession('wqb_BBBBBBBBBBBBBBBBBBBBBBBB', false);
  assert.deepEqual(bad, { ok: false, reason: 'invalid', remainingAttempts: MAX_ATTEMPTS - 1 });

  const good = auth.createSession('wqb_AAAAAAAAAAAAAAAAAAAAAAAA', false);
  assert.equal(good.ok, true);
  if (!good.ok) return;
  assert.equal(auth.resolve(good.session.id)?.id, good.session.id);
  assert.equal(auth.resolve('deadbeef'), undefined);
});

test('连续 5 次失败锁 30 秒，锁定期间不再泄露剩余次数', () => {
  const auth = new WebUiAuth('wqb_AAAAAAAAAAAAAAAAAAAAAAAA');
  const now = 1_000_000;
  for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
    const result = auth.createSession('wrong', false, now);
    assert.equal(result.ok, false);
  }
  const locked = auth.createSession('wrong', false, now);
  assert.deepEqual(locked, { ok: false, reason: 'locked', retryAfterMs: LOCK_MS });

  // 锁定期内即使令牌正确也拒绝。
  const duringLock = auth.createSession('wqb_AAAAAAAAAAAAAAAAAAAAAAAA', false, now + 1000);
  assert.equal(duringLock.ok, false);
  if (!duringLock.ok) assert.equal(duringLock.reason, 'locked');

  // 到点解锁。
  const after = auth.createSession('wqb_AAAAAAAAAAAAAAAAAAAAAAAA', false, now + LOCK_MS);
  assert.equal(after.ok, true);
});

test('退出控制台只删会话；会话过期后 resolve 返回 undefined', () => {
  const auth = new WebUiAuth('wqb_AAAAAAAAAAAAAAAAAAAAAAAA');
  const now = 5_000_000;
  const created = auth.createSession('wqb_AAAAAAAAAAAAAAAAAAAAAAAA', false, now);
  assert.equal(created.ok, true);
  if (!created.ok) return;

  auth.revoke(created.session.id);
  assert.equal(auth.resolve(created.session.id, now), undefined);

  const again = auth.createSession('wqb_AAAAAAAAAAAAAAAAAAAAAAAA', false, now);
  assert.equal(again.ok, true);
  if (!again.ok) return;
  // 12 小时后过期。
  assert.equal(auth.resolve(again.session.id, now + 13 * 60 * 60 * 1000), undefined);
});

test('长度不同的候选令牌也走比较、不会命中', () => {
  const auth = new WebUiAuth('wqb_AAAAAAAAAAAAAAAAAAAAAAAA');
  assert.equal(auth.createSession('', false).ok, false);
  assert.equal(auth.createSession('wqb_AAAAAAAAAAAAAAAAAAAAAAA', false).ok, false);
  assert.equal(auth.createSession('wqb_AAAAAAAAAAAAAAAAAAAAAAAAA', false).ok, false);
});

test('cookie：remember 才带 Max-Age，且永远 HttpOnly + SameSite=Strict', () => {
  const auth = new WebUiAuth('wqb_AAAAAAAAAAAAAAAAAAAAAAAA');
  const quick = auth.createSession('wqb_AAAAAAAAAAAAAAAAAAAAAAAA', false);
  const remembered = auth.createSession('wqb_AAAAAAAAAAAAAAAAAAAAAAAA', true);
  assert.equal(quick.ok && remembered.ok, true);
  if (!quick.ok || !remembered.ok) return;

  const sessionOnly = sessionCookie(quick.session);
  assert.ok(sessionOnly.attributes.includes('HttpOnly'));
  assert.ok(sessionOnly.attributes.includes('SameSite=Strict'));
  assert.ok(!sessionOnly.attributes.some((attr) => attr.startsWith('Max-Age=')));

  const persistent = sessionCookie(remembered.session);
  const maxAge = persistent.attributes.find((attr) => attr.startsWith('Max-Age='));
  assert.ok(maxAge);
  assert.match(maxAge!, /^Max-Age=[1-9]\d*$/);
});
