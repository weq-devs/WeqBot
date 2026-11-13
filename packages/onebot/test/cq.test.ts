/** CQ 码编解码：转义顺序与回环。 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { cqEscape, cqUnescape, parseCQString, segmentsToRawMessage } from '../src/cq';

test('转义与反转义往返', () => {
  const original = 'a[b]c,d&e';
  assert.equal(cqUnescape(cqEscape(original)), original);
});

test('`&amp;` 必须最后解，不能双解', () => {
  // 如果先解 `&amp;`，`&amp;#91;` 会变成 `[`，就是错的。
  assert.equal(cqUnescape('&amp;#91;'), '&#91;');
  assert.equal(cqUnescape('&#91;'), '[');
});

test('CQ 串拆成 segment', () => {
  const segments = parseCQString('hi[CQ:at,qq=10001] there');
  assert.deepEqual(segments, [
    { type: 'text', data: { text: 'hi' } },
    { type: 'at', data: { qq: '10001' } },
    { type: 'text', data: { text: ' there' } },
  ]);
});

test('segment 拼回 CQ 串', () => {
  const raw = segmentsToRawMessage([
    { type: 'text', data: { text: 'hi' } },
    { type: 'at', data: { qq: '10001' } },
  ]);
  assert.equal(raw, 'hi[CQ:at,qq=10001]');
});
