/**
 * 媒体来源（URL → 字节）。
 *
 * 这段代码的契约是「OneBot 客户端只给 `url` 时也能发出去」，所以用例全部离线：
 * 注入假 `fetchImpl`，验的是
 *   - 正常下载拿到字节；
 *   - 超上限（声明 / 实际两种）都拒绝，不把半个文件传上去；
 *   - 空内容 / 非 2xx / 重定向到非 http(s) / 非法 URL 都明确报错；
 *   - 错误信息带上下文（`what`）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchMediaBytes, isHttpUrl, MAX_MEDIA_DOWNLOAD_BYTES } from '../src/media-source';

function okResponse(bytes: Uint8Array, init: ResponseInit = {}): Response {
  return new Response(Uint8Array.from(bytes), { status: 200, ...init });
}

test('isHttpUrl 只认 http(s)', () => {
  assert.equal(isHttpUrl('https://example.com/a.png'), true);
  assert.equal(isHttpUrl('HTTP://x'), true);
  assert.equal(isHttpUrl('http://x'), true);
  assert.equal(isHttpUrl('file:///etc/passwd'), false);
  assert.equal(isHttpUrl('/tmp/a.png'), false);
  assert.equal(isHttpUrl('base64://AAAA'), false);
});

test('下载到字节', async () => {
  const fetchImpl = (async () => okResponse(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch;
  const bytes = await fetchMediaBytes('https://example.com/a.png', { fetchImpl, what: '图片' });
  assert.deepEqual([...bytes], [1, 2, 3]);
});

test('声明超限直接拒绝，不读 body', async () => {
  const fetchImpl = (async () =>
    okResponse(new Uint8Array([1]), {
      headers: { 'content-length': String(MAX_MEDIA_DOWNLOAD_BYTES + 1) },
    })) as unknown as typeof fetch;
  await assert.rejects(
    fetchMediaBytes('https://e.com/x', { fetchImpl, what: '图片' }),
    /超过下载上限/,
  );
});

test('实际字节超限也拒绝', async () => {
  const fetchImpl = (async () =>
    okResponse(new Uint8Array(8), {
      headers: { 'content-length': '1' },
    })) as unknown as typeof fetch;
  await assert.rejects(
    fetchMediaBytes('https://e.com/x', { fetchImpl, what: '图片', maxBytes: 4 }),
    /超过下载上限/,
  );
});

test('空内容 / 非 2xx / 非法 URL / 非 http 协议都报错', async () => {
  const empty = (async () => okResponse(new Uint8Array(0))) as unknown as typeof fetch;
  await assert.rejects(
    fetchMediaBytes('https://e.com/x', { fetchImpl: empty, what: '语音' }),
    /空内容/,
  );

  const bad = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
  await assert.rejects(
    fetchMediaBytes('https://e.com/x', { fetchImpl: bad, what: '语音' }),
    /HTTP 404/,
  );

  await assert.rejects(fetchMediaBytes('not a url', { what: '语音' }), /URL 非法/);
  await assert.rejects(fetchMediaBytes('file:///etc/passwd', { what: '语音' }), /只支持 http\(s\)/);
});

test('重定向到非 http(s) 拒绝', async () => {
  // `Response.url` 只读，这里用一个带 url 的替身模拟 follow 之后的落地地址。
  const fetchImpl = (async () => {
    const response = okResponse(new Uint8Array([1]));
    Object.defineProperty(response, 'url', { value: 'file:///etc/passwd' });
    return response;
  }) as unknown as typeof fetch;
  await assert.rejects(
    fetchMediaBytes('https://e.com/x', { fetchImpl, what: '图片' }),
    /非 http\(s\)/,
  );
});

test('网络异常带上上下文', async () => {
  const fetchImpl = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  await assert.rejects(
    fetchMediaBytes('https://e.com/x', { fetchImpl, what: '视频' }),
    /视频 下载失败/,
  );
});
