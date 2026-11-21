import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebAuthError } from '../src/web/credential';
import { getQzoneBlog, getQzoneBlogComments, getQzoneBlogs } from '../src/web/qzone_blog';

const cred = { uin: '10001', skey: '', pskey: 'fixture' };
const owner = '10002';

test('列表保持历史范围，短页按实际条数前进，已知末页停止', async ({ mock }) => {
  mock.method(globalThis, 'fetch', async (input: string) => {
    const url = new URL(input);
    assert.equal(url.searchParams.get('hostUin'), owner);
    assert.equal(url.searchParams.get('uin'), cred.uin);
    assert.equal(url.searchParams.get('statYear'), '');
    const offset = Number(url.searchParams.get('pos'));
    const list =
      offset === 0 ? [{ blogId: 7, title: '试验日志', img: [{ url: '//qpic.cn/test' }] }] : [];
    return new Response(`_Callback(${JSON.stringify({ code: 0, data: { totalNum: 2, list } })});`);
  });
  const first = await getQzoneBlogs(cred, owner, 0, 20);
  assert.equal(first.nextOffset, 1);
  assert.deepEqual(first.items[0]?.images, ['https://qpic.cn/test']);
  assert.equal(first.items[0]?.commentCount, null);
  await assert.rejects(getQzoneBlogs(cred, owner, 1, 20), /本页为空/);
  assert.deepEqual(await getQzoneBlogs(cred, owner, 2, 20), { items: [], nextOffset: null });
});

test('登录错误走现有换票机制，缺失状态的回包不会变成空列表', async ({ mock }) => {
  const send = mock.method(globalThis, 'fetch', async () => new Response('{"code":-3000}'));
  await assert.rejects(getQzoneBlogs(cred, owner, 0, 20), WebAuthError);
  send.mock.mockImplementation(async () => new Response('{"data":{"totalNum":0,"list":[]}}'));
  await assert.rejects(getQzoneBlogs(cred, owner, 0, 20), /读取日志列表失败/);
});

test('按声明的 GBK 系编码读取正文，只提取日志区域', async ({ mock }) => {
  mock.method(globalThis, 'fetch', async (input: string) => {
    const url = new URL(input);
    assert.equal(url.searchParams.get('blogid'), '7');
    assert.equal(url.searchParams.get('outCharset'), 'gb2312');
    return new Response(
      Buffer.concat([
        Buffer.from('<title>Outer</title><div id="blogDetailDiv"><p>'),
        Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
        Buffer.from('</p></div><footer>Outer</footer>'),
      ]),
    );
  });
  assert.deepEqual(await getQzoneBlog(cred, owner, '7'), { html: '<p>中文</p>' });
});

test('评论分页使用日志所属人和日志 ID，保留实际评论编号', async ({ mock }) => {
  mock.method(globalThis, 'fetch', async (input: string) => {
    const url = new URL(input);
    assert.equal(url.searchParams.get('topicId'), '10002_7');
    assert.equal(url.searchParams.get('start'), '1');
    return Response.json({
      code: 0,
      data: {
        total: 2,
        comments: [
          {
            id: 8,
            content: '试验评论',
            postTime: 123,
            poster: { id: '10003', name: '评论者' },
          },
        ],
      },
    });
  });
  const result = await getQzoneBlogComments(cred, owner, '7', 1, 20);
  assert.equal(result.nextOffset, null);
  assert.deepEqual(result.items, [
    { id: '8', text: '试验评论', time: 123, uin: '10003', nickname: '评论者' },
  ]);
});
