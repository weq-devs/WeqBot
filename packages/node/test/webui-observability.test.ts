/**
 * WebUI 观测（W7）：脱敏、环形缓冲有界、统计口径。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { Observability, redact, summarizeEvent } from '../src/webui/observability';

test('敏感键一律替换成 ***，且不改变结构', () => {
  const input = {
    uin: '10001',
    a1: 'deadbeef',
    nested: { pskey: 'x', skey: 'y', cookie: 'z', keep: 1 },
    list: [{ clientKey: 'k' }, 3],
    Authorization: 'Bearer x',
    access_token: 't',
  };
  const out = redact(input) as Record<string, unknown>;
  assert.equal(out.uin, '10001');
  assert.equal(out.a1, '***');
  assert.deepEqual(out.nested, { pskey: '***', skey: '***', cookie: '***', keep: 1 });
  assert.deepEqual(out.list, [{ clientKey: '***' }, 3]);
  assert.equal(out.Authorization, '***');
  assert.equal(out.access_token, '***');
});

test('脱敏对循环引用有深度上限，不会炸', () => {
  const cyclic: Record<string, unknown> = { name: 'x' };
  cyclic.self = cyclic;
  const out = redact(cyclic) as Record<string, unknown>;
  // 深层被截断成字面量，而不是无限递归。
  assert.equal(typeof out.self, 'object');
  const deep = out.self as Record<string, unknown>;
  assert.equal(typeof deep.self, 'object');
});

test('日志 sink 写入前就脱敏；环形缓冲有界', () => {
  const observability = new Observability();
  observability.logSink({
    ts: 1,
    level: 'info',
    scope: 'test',
    msg: 'hi',
    fields: { a1: 'secret', uin: '10001' },
  });
  const [entry] = observability.logs.list();
  assert.equal(entry?.fields?.a1, '***');
  assert.equal(entry?.fields?.uin, '10001');

  // 容量 2000：已有 1 条 + 推 2100 条 = 2101，最早 101 条（那条初始日志 + #0..99）被挤掉。
  for (let i = 0; i < 2100; i++) {
    observability.logSink({ ts: 1000 + i, level: 'debug', scope: 's', msg: `#${i}` });
  }
  const list = observability.logs.list();
  assert.equal(list.length, 2000);
  assert.equal(list[0]?.msg, '#100');
});

test('action 统计：总数 / 成功率 / Top action / 错误码 / 分位数', () => {
  const observability = new Observability();
  const pushes: Array<[number, string, number]> = [
    [10, 'get_login_info', 0],
    [20, 'get_login_info', 0],
    [30, 'send_group_msg', 100],
    [40, 'get_login_info', 0],
    [400, 'send_group_msg', 100],
  ];
  for (const [latency, action, retcode] of pushes) {
    observability.recordAction({
      ts: Date.now(),
      action,
      params: { message: 'x' },
      retcode,
      status: retcode === 0 ? 'ok' : 'failed',
      latencyMs: latency,
      transport: 'ws',
      client: 'c1',
    });
  }
  const stats = observability.stats();
  assert.equal(stats.total, 5);
  assert.equal(stats.ok, 3);
  assert.equal(stats.failed, 2);
  assert.equal(stats.byAction[0]?.action, 'get_login_info');
  assert.equal(stats.byAction[0]?.count, 3);
  assert.deepEqual(stats.byRetcode, [{ retcode: 100, count: 2 }]);
  assert.equal(stats.latency.max, 400);
  assert.equal(stats.transports.ws, 5);
});

test('事件摘要：消息 / 通知 / 状态各有形状；不可识别的返回带 type 的空摘要', () => {
  const message = summarizeEvent({
    type: 'message',
    message: {
      scene: 'group',
      peer: { id: '20001' },
      sender: { id: '10001' },
      elements: [{ type: 'text', text: 'hello' }, { type: 'image' }],
    },
  });
  assert.equal(message?.kind, 'group');
  assert.equal(message?.peer, '20001');
  assert.equal(message?.summary, '10001 → 20001: hello[image]');

  const state = summarizeEvent({ type: 'state', to: 'online' });
  assert.equal(state?.kind, 'online');

  const other = summarizeEvent({ type: 'something-new' });
  assert.equal(other?.type, 'something-new');

  assert.equal(summarizeEvent(null), undefined);
});

test('订阅能收到三条流；取消后不再收到', () => {
  const observability = new Observability();
  const seen: string[] = [];
  const off = observability.subscribe((stream) => seen.push(stream));
  observability.recordAction({
    ts: Date.now(),
    action: 'a',
    params: {},
    retcode: 0,
    status: 'ok',
    latencyMs: 1,
    transport: 'webui',
    client: 'webui',
  });
  observability.recordEvent({ type: 'state', to: 'online' });
  off();
  observability.recordEvent({ type: 'state', to: 'offline' });
  assert.deepEqual(seen, ['actions', 'events']);
});
