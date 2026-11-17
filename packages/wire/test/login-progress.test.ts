/**
 * `parseLoginProgress`：native 的 `QuickLoginEvent` → 面向用户的进度事件。
 *
 * 守两条线：
 *
 * 1. **异常设备一定有话可说** —— native 等手机确认最长 45 秒，message 缺失时
 *    必须由这一层补上，否则页面只剩一个转圈。
 * 2. **认证物料不外流** —— `unusualDeviceCheckSig` / `qrImage` 不能出现在
 *    返回值里；上层没有用处，多传一次就多一个泄漏面。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { isAwaitingPhoneConfirmation, parseLoginProgress } from '../src/login-progress';

test('unusual-device 带 native 文案原样透出', () => {
  const progress = parseLoginProgress({
    kind: 'unusual-device',
    state: 'unusual-device',
    message: '当前设备被判定为异常设备，需要用户确认或扫码',
    unusualDeviceCheckSig: Buffer.from([1, 2, 3]),
  });
  assert.equal(progress?.kind, 'unusual-device');
  assert.equal(progress?.message, '当前设备被判定为异常设备，需要用户确认或扫码');
  assert.equal(isAwaitingPhoneConfirmation(progress!), true);
});

test('unusual-device 缺 message 时补上手机确认提示（不能返回空文案）', () => {
  const progress = parseLoginProgress({ kind: 'unusual-device', unusualDeviceQrSig: 'abc' });
  assert.equal(progress?.kind, 'unusual-device');
  assert.match(progress!.message, /确认登录/);
});

test('unusual-device-wait 阶段没有 message 时用阶段名兜底', () => {
  const progress = parseLoginProgress({ kind: 'state', state: 'unusual-device-wait' });
  assert.equal(progress?.kind, 'state');
  assert.equal(progress?.state, 'unusual-device-wait');
  assert.match(progress!.message, /确认登录/);
  assert.equal(isAwaitingPhoneConfirmation(progress!), true);
});

test('认证物料不出现在返回值里', () => {
  const progress = parseLoginProgress({
    kind: 'unusual-device',
    unusualDeviceCheckSig: Buffer.alloc(32),
    unusualDeviceQrSig: 'sig',
    uinToken: 'token',
  });
  assert.ok(progress);
  const keys = Object.keys(progress).sort();
  assert.deepEqual(keys, ['kind', 'message']);
});

test('已知阶段按阶段名映射成中文说明', () => {
  const progress = parseLoginProgress({ kind: 'state', state: 'key-exchange' });
  assert.equal(progress?.kind, 'state');
  assert.match(progress!.message, /会话密钥/);
});

test('未知 kind / 缺 kind / 非对象一律忽略（不硬塞一条看不懂的提示）', () => {
  assert.equal(parseLoginProgress({ kind: 'qr-code', qrUrl: 'https://x' }), undefined);
  assert.equal(parseLoginProgress({ kind: 'whatever' }), undefined);
  assert.equal(parseLoginProgress({ state: 'key-exchange' }), undefined);
  assert.equal(parseLoginProgress(null), undefined);
  assert.equal(parseLoginProgress('unusual-device'), undefined);
});

test('qr-state 透出状态与文案；confirmed 不算等待确认', () => {
  const progress = parseLoginProgress({
    kind: 'qr-state',
    state: 'waiting-confirm',
    message: '已扫码，等待手机确认',
  });
  assert.equal(progress?.kind, 'qr-state');
  assert.equal(progress?.state, 'waiting-confirm');
  assert.equal(isAwaitingPhoneConfirmation(progress!), true);

  const confirmed = parseLoginProgress({ kind: 'qr-state', state: 'confirmed' });
  assert.equal(confirmed?.state, 'confirmed');
  assert.equal(isAwaitingPhoneConfirmation(confirmed!), false);
});
