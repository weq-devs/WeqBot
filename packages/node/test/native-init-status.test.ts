/**
 * 加载器对 `getInitStatus()` 的前置检查。
 *
 * 时效本身仍由 nt_helper 判定，这里只锁住两件事：过期要在加载时说人话；
 * 未知状态不能静默放行。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { NATIVE_INIT_STATUS, assertNativeInitStatus } from '../src/loader';

test('成功和旧产物缺导出都放行', () => {
  assert.doesNotThrow(() => assertNativeInitStatus(NATIVE_INIT_STATUS.success));
  assert.doesNotThrow(() => assertNativeInitStatus(undefined));
});

test('过期给出更新提示，而不是等到第一次 native 调用', () => {
  assert.throws(
    () => assertNativeInitStatus(NATIVE_INIT_STATUS.expired),
    /原生组件已过期.*native:fetch/,
  );
});

test('损坏和篡改分别报错', () => {
  assert.throws(() => assertNativeInitStatus(NATIVE_INIT_STATUS.damaged), /安装损坏/);
  assert.throws(() => assertNativeInitStatus(NATIVE_INIT_STATUS.tampered), /被篡改/);
});

test('未知状态带上原始状态码', () => {
  assert.throws(() => assertNativeInitStatus(99), /getInitStatus\(\)=99/);
});
