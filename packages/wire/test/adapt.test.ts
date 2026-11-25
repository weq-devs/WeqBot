/**
 * `adaptNativeBinding` 的回调形状。
 *
 * 这里守的是一条真机踩过的坑：native 的 `ThreadsafeFunction<T>` 按 Node 约定
 * 以 `(err, value)` 调用回调。适配层如果把 TS 的 sink 直接透传下去，回调第一个
 * 参数就是 `null`，`event.kind` 立刻抛 TypeError —— 而且是在 native 的 TSFN 里
 * 抛的，整个进程直接退出（不是可捕获的 Promise rejection）。
 *
 * 用假 binding 复刻 native 的调用约定，保证适配层永远先剥掉 err 位。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { adaptNativeBinding } from '../src/adapt';
import type { SessionStatusEvent } from '../src/types';

const HEARTBEAT: SessionStatusEvent = { kind: 'heartbeat', sessionId: 1, ts: 123, rttMs: 42 };

test('status sink 剥掉 Node 风格的 err 位', async () => {
  let nativeSink: ((error: Error | null, event: SessionStatusEvent) => void) | undefined;
  const native = adaptNativeBinding({
    sendPacket: async () => Buffer.alloc(0),
    sendOidbPacket: async () => Buffer.alloc(0),
    attachStatusSink: async (_sessionId, sink) => {
      nativeSink = sink;
    },
    detachStatusSink: async () => true,
  });

  const received: SessionStatusEvent[] = [];
  await native.attachStatusSink!(1, (event) => received.push(event));

  // native 的真实调用方式：先 err，再 value。
  nativeSink!(null, HEARTBEAT);
  assert.deepEqual(received, [HEARTBEAT]);
});

test('status sink 遇到 err 时不把错误对象当事件传下去', async () => {
  let nativeSink: ((error: Error | null, event: SessionStatusEvent) => void) | undefined;
  const native = adaptNativeBinding({
    sendPacket: async () => Buffer.alloc(0),
    sendOidbPacket: async () => Buffer.alloc(0),
    attachStatusSink: async (_sessionId, sink) => {
      nativeSink = sink;
    },
  });

  const received: unknown[] = [];
  await native.attachStatusSink!(1, (event) => received.push(event));

  // 这条在修复前会往 sink 里塞一个 Error，随后 `event.kind` 抛 TypeError。
  nativeSink!(new Error('tsfn 出错'), undefined as never);
  assert.deepEqual(received, []);
});

test('push sink 同样是 Node 风格（回归保护）', async () => {
  let nativeSink: ((error: Error | null, frame: unknown) => void) | undefined;
  const native = adaptNativeBinding({
    sendPacket: async () => Buffer.alloc(0),
    sendOidbPacket: async () => Buffer.alloc(0),
    attachPushSink: async (_sessionId, sink) => {
      nativeSink = sink;
    },
  });

  const frames: unknown[] = [];
  const errors: Error[] = [];
  await native.attachPushSink!(
    1,
    (frame) => frames.push(frame),
    (error) => errors.push(error),
  );

  const frame = { sessionId: 1, command: 'x', body: new Uint8Array(), seq: 0, ts: 0 };
  nativeSink!(null, frame);
  nativeSink!(new Error('boom'), undefined as never);

  assert.deepEqual(frames, [frame]);
  assert.equal(errors.length, 1);
});

test('trace 默认只记录报文元数据，原始字节需另行启用', () => {
  const adaptation = new URL('../src/adapt.ts', import.meta.url).href;
  const script = `
    import { adaptNativeBinding } from ${JSON.stringify(adaptation)};
    const native = adaptNativeBinding({ sendPacket: async () => Buffer.from('synthetic reply') });
    await native.sendPacket(1, 'fixture.Command', Buffer.from('synthetic request'));
  `;
  for (const raw of ['', '1']) {
    const run = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      {
        env: { ...process.env, WEQBOT_LOG_LEVEL: 'trace', WEQBOT_TRACE_PACKET_BYTES: raw },
        encoding: 'utf8',
        timeout: 5000,
      },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /fixture\.Command/);
    assert.match(run.stderr, /elapsedMs/);
    for (const payload of ['synthetic request', 'synthetic reply']) {
      assert.equal(run.stderr.includes(Buffer.from(payload).toString('hex')), raw === '1');
    }
  }
});
