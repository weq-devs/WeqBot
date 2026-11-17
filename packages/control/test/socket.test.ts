/** 控制通道的 socket 传输：分帧、多客户端广播、残留路径文件、协议错。 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  controlEvent,
  controlFailure,
  controlSuccess,
  type ControlEnvelope,
  type ControlServerPeer,
} from '../src/index';
import { connectControlSocket, defaultControlSocketPath, listenControlSocket } from '../src/socket';

const unixOnly = process.platform === 'win32' ? 'unix socket 专属' : false;

async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'weqbot-socket-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('等待超时');
}

test('socket：请求-应答 + 多客户端广播事件', { skip: unixOnly }, async () => {
  const { dir, cleanup } = await tempDir();
  const path = join(dir, 'control.sock');
  const peers: ControlServerPeer[] = [];
  const server = await listenControlSocket({
    path,
    onPeer(peer) {
      peers.push(peer);
      peer.onRequest((envelope) => {
        if (envelope.kind !== 'request') return;
        if (envelope.method === 'boom') {
          peer.send(controlFailure(envelope.id, { code: 'LOGIN_FAILED', message: '炸了' }));
          return;
        }
        peer.send(controlSuccess(envelope.id, { pong: envelope.method }));
      });
    },
  });

  try {
    assert.equal(server.path, path);
    assert.ok(existsSync(path));
    const first = await connectControlSocket({ path });
    const second = await connectControlSocket({ path });

    assert.deepEqual(await first.request('ping', {}), { pong: 'ping' });
    assert.deepEqual(await second.request('status', {}), { pong: 'status' });

    await assert.rejects(first.request('boom', {}), (error: Error) => {
      assert.equal((error as { code?: string }).code, 'LOGIN_FAILED');
      assert.match(error.message, /炸了/);
      return true;
    });

    // 广播：两条连接都要收到。
    const received: ControlEnvelope[][] = [[], []];
    first.on((envelope) => received[0]!.push(envelope));
    second.on((envelope) => received[1]!.push(envelope));
    assert.equal(peers.length, 2);
    for (const peer of peers) peer.send(controlEvent('state', { state: 'online' }));
    await waitFor(() => received[0]!.length === 1 && received[1]!.length === 1);
    assert.deepEqual(received[1]![0], {
      v: 1,
      kind: 'event',
      event: 'state',
      data: { state: 'online' },
    });

    first.close();
    assert.equal(first.closed, true);
  } finally {
    await server.close();
    await cleanup();
  }
  assert.equal(existsSync(path), false, '关闭后要清掉 socket 文件');
});

test('socket：客户端发 response / 非 JSON 会被拒', { skip: unixOnly }, async () => {
  const { dir, cleanup } = await tempDir();
  const path = join(dir, 'bad.sock');
  const seen: ControlEnvelope[] = [];
  const server = await listenControlSocket({
    path,
    onPeer(peer) {
      peer.onRequest((envelope) => seen.push(envelope));
    },
  });

  try {
    const client = await connectControlSocket({ path });
    const replies: ControlEnvelope[] = [];
    client.on((envelope) => replies.push(envelope));

    // 伪造一个 response 信封：服务端必须回 CONTROL_PROTOCOL_ERROR 而不是照收。
    const raw = connect(path);
    await new Promise<void>((resolve) => raw.once('connect', () => resolve()));
    const lines: ControlEnvelope[] = [];
    let buffer = '';
    raw.on('data', (chunk: Uint8Array) => {
      buffer += new TextDecoder().decode(chunk);
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        lines.push(JSON.parse(buffer.slice(0, index)) as ControlEnvelope);
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
      }
    });
    raw.write(`${JSON.stringify({ v: 1, kind: 'response', id: 3, ok: true, result: null })}\n`);
    await waitFor(() => lines.length >= 1);
    assert.equal(lines[0]?.kind, 'response');
    assert.equal((lines[0] as { ok?: boolean }).ok, false);
    assert.match(
      String((lines[0] as { error?: { message?: string } }).error?.message),
      /只接受 request/,
    );

    // 非 JSON 行：回一条失败然后断开。
    raw.write('not json\n');
    await waitFor(() => lines.length >= 2);
    assert.match(String((lines[1] as { error?: { message?: string } }).error?.message), /非 JSON/);
    raw.destroy();
    client.close();
    assert.deepEqual(seen, []);
  } finally {
    await server.close();
    await cleanup();
  }
});

test('socket：崩溃残留的路径文件会被接管，活着的监听者不会被抢', { skip: unixOnly }, async () => {
  const { dir, cleanup } = await tempDir();
  const path = join(dir, 'stale.sock');

  try {
    // 上次崩溃留下的普通文件（没有监听者）：应当被清掉并成功 listen。
    await writeFile(path, '');
    const server = await listenControlSocket({ path, onPeer() {} });

    // 已经有活着的 daemon：第二个 listen 必须报错，而不是把前一个的路径删掉。
    await assert.rejects(listenControlSocket({ path, onPeer() {} }), /EADDRINUSE|已有|address/i);

    await server.close();
  } finally {
    await cleanup();
  }
});

test('defaultControlSocketPath：按 uin 取名，非数字不拼进路径', () => {
  const path = defaultControlSocketPath('10001');
  assert.match(path, /weqbot-10001/);
  const unsafe = defaultControlSocketPath('../../etc/passwd');
  assert.match(unsafe, /weqbot(\.sock)?$/);
  assert.doesNotMatch(unsafe, /passwd/);
});
