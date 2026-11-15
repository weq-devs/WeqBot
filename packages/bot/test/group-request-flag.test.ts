/**
 * 群请求 flag 解析。
 *
 * flag 是 OneBot 的不透明句柄，但 WeqBot 自己产出三种形态，`0x10C8` 只认四元组。
 * 这里固定「哪种形态解成什么」，以及非法形态必须报错而不是猜。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGroupRequestFlag } from '../src/group-request-flag';

test('slreq 规范形态：四元组齐全', () => {
  assert.deepEqual(parseGroupRequestFlag('slreq:1:123456:987654:1:0'), {
    kind: 'canonical',
    sequence: 123456,
    groupId: 987654,
    eventType: 1,
    filtered: false,
  });
  assert.equal(
    parseGroupRequestFlag('slreq:1:1:2:22:1').kind === 'canonical'
      ? (parseGroupRequestFlag('slreq:1:1:2:22:1') as { filtered: boolean }).filtered
      : null,
    true,
  );
});

test('裸序号', () => {
  assert.deepEqual(parseGroupRequestFlag('42'), { kind: 'sequence', sequence: 42 });
});

test('推送形态 add / invite：group_id + uid', () => {
  assert.deepEqual(parseGroupRequestFlag('add:987654:u_guest'), {
    kind: 'legacy',
    requestType: 'add',
    groupId: 987654,
    targetUid: 'u_guest',
  });
  assert.deepEqual(parseGroupRequestFlag('invite:987654:u_host'), {
    kind: 'legacy',
    requestType: 'invite',
    groupId: 987654,
    targetUid: 'u_host',
  });
});

test('uid 里带冒号时整段保留', () => {
  const parsed = parseGroupRequestFlag('add:1:u_a:u_b');
  assert.equal(parsed.kind, 'legacy');
  if (parsed.kind === 'legacy') assert.equal(parsed.targetUid, 'u_a:u_b');
});

test('非法形态一律抛错，不猜', () => {
  for (const bad of [
    '',
    '   ',
    'slreq:2:1:2:3:0',
    'slreq:1:1:2:3',
    'slreq:1:1:2:3:7',
    'slreq:1:0:2:3:0',
    'remove:1:u_x',
    'add:1',
    'add:0:u_x',
    'add:1:',
    '-5',
    '1.5',
  ]) {
    assert.throws(() => parseGroupRequestFlag(bad), `应拒绝：${JSON.stringify(bad)}`);
  }
});
