/**
 * 入站媒体 URL 解析器。
 *
 * 这里刻意用假 `ProtocolClient`：真实 rkey 要联网，而这段代码的契约是
 * 「拿到 fileToken → 拼出 CDN 直链」，与网络无关。要验的是：
 *   - 私聊 / 群用不同的 rkey type 与 appid；
 *   - rkey 自带 `&rkey=` 前缀时不要重复加；
 *   - 没有 fileToken、没有 rkey、请求抛错时都只返回空串（不把事件搞挂）；
 *   - 同一批 rkey 在 TTL 内只请求一次。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProtocolClient, DownloadRkey } from '@weqbot/protocol';
import { createMediaUrlResolver } from '../src/media-url';

const NOW = Math.floor(Date.now() / 1000);

function rkey(type: number, value: string, overrides: Partial<DownloadRkey> = {}): DownloadRkey {
  return {
    rkey: `&rkey=${value}`,
    type,
    ttlSeconds: 3600,
    createTime: NOW,
    ...overrides,
  };
}

interface Harness {
  protocol: ProtocolClient;
  requests: number[][];
}

function makeProtocol(entries: DownloadRkey[] | (() => Promise<DownloadRkey[]>)): Harness {
  const requests: number[][] = [];
  const protocol: ProtocolClient = {
    native: {} as ProtocolClient['native'],
    sessionId: 7,
    // 解析器只走 `oidb()`；顺手记下请求的 types —— 那是「按场景要对了 rkey」
    // 的唯一证据。
    oidb: (async <TResult>(_spec: unknown, params: { types?: number[] }) => {
      requests.push(params.types ?? []);
      return (typeof entries === 'function' ? await entries() : entries) as TResult;
    }) as ProtocolClient['oidb'],
    trpc: async () => [] as never,
    raw: async () => new Uint8Array(),
  };
  return { protocol, requests };
}

test('群图片：用 type 20 的 rkey + appid 1407', async () => {
  const { protocol, requests } = makeProtocol([rkey(20, 'GROUPIMG'), rkey(2, 'FALLBACK')]);
  const resolver = createMediaUrlResolver({ protocol });

  const url = await resolver.imageUrl({ kind: 'pic', fileToken: 'tok+1' }, true);

  assert.deepEqual(requests[0], [20, 2]);
  assert.ok(url.startsWith('https://multimedia.nt.qq.com.cn/download?'));
  assert.ok(url.includes('appid=1407'), url);
  assert.ok(url.includes(`fileid=${encodeURIComponent('tok+1')}`), url);
  assert.ok(url.includes('&spec=0&rkey=GROUPIMG'), url);
});

test('私聊图片：用 type 10 的 rkey + appid 1406', async () => {
  const { protocol } = makeProtocol([rkey(10, 'PRIVIMG')]);
  const resolver = createMediaUrlResolver({ protocol });

  const url = await resolver.imageUrl({ kind: 'pic', fileToken: 'tok' }, false);

  assert.ok(url.includes('appid=1406'), url);
  assert.ok(url.includes('&rkey=PRIVIMG'), url);
});

test('rkey 不带 &rkey= 前缀时补上，不重复', async () => {
  const { protocol } = makeProtocol([rkey(10, 'RAW', { rkey: 'RAW' })]);
  const resolver = createMediaUrlResolver({ protocol });

  const url = await resolver.imageUrl({ kind: 'pic', fileToken: 'tok' }, false);

  assert.ok(url.endsWith('&spec=0&rkey=RAW'), url);
  assert.equal(url.match(/rkey=/g)?.length, 1, url);
});

test('语音 / 视频按种类要 rkey；kind 不认识时留空', async () => {
  const { protocol, requests } = makeProtocol([
    rkey(24, 'GROUPPTT'),
    rkey(22, 'GROUPVIDEO'),
    rkey(2, 'FALLBACK'),
  ]);
  const resolver = createMediaUrlResolver({ protocol });

  const ptt = await resolver.mediaUrl({ kind: 'ptt', fileToken: 'a' }, true);
  assert.deepEqual(requests[0], [24, 2]);
  assert.ok(ptt.includes('&rkey=GROUPPTT'), ptt);

  const video = await resolver.mediaUrl({ kind: 'video', fileToken: 'b' }, true);
  assert.ok(video.includes('&rkey=GROUPVIDEO'), video);

  const file = await resolver.mediaUrl({ kind: 'file', fileToken: 'c' }, true);
  assert.equal(file, '');
});

test('缺 fileToken 直接返回空串，不发请求', async () => {
  const { protocol, requests } = makeProtocol([rkey(10, 'X')]);
  const resolver = createMediaUrlResolver({ protocol });

  assert.equal(await resolver.imageUrl({ kind: 'pic' }, false), '');
  assert.equal(requests.length, 0);
});

test('请求 rkey 抛错时返回空串，不把事件搞挂', async () => {
  const { protocol } = makeProtocol(async () => {
    throw new Error('network down');
  });
  const resolver = createMediaUrlResolver({ protocol });

  assert.equal(await resolver.imageUrl({ kind: 'pic', fileToken: 'tok' }, false), '');
});

test('同一批 rkey 在 TTL 内只请求一次', async () => {
  const { protocol, requests } = makeProtocol([rkey(10, 'PRIVIMG')]);
  const resolver = createMediaUrlResolver({ protocol });

  await resolver.imageUrl({ kind: 'pic', fileToken: 'a' }, false);
  await resolver.imageUrl({ kind: 'pic', fileToken: 'b' }, false);

  assert.equal(requests.length, 1);
});

test('已过期的缓存不再复用', async () => {
  const expired = rkey(10, 'OLD', { createTime: NOW - 7200, ttlSeconds: 60 });
  const { protocol, requests } = makeProtocol([expired]);
  const resolver = createMediaUrlResolver({ protocol });

  await resolver.imageUrl({ kind: 'pic', fileToken: 'a' }, false);
  await resolver.imageUrl({ kind: 'pic', fileToken: 'b' }, false);

  assert.equal(requests.length, 2);
});
