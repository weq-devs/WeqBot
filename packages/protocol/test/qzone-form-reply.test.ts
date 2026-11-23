/**
 * 空间写接口回执解析 + 转发请求形状。
 *
 * 复用 WeQ 的 HTML／JavaScript 解析行为，字符串、注释和伪回调均不算回执。
 *
 * 网络层用假的 `fetch` 拦住 `webRequestText`，只验请求体与解析结果。
 */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { parseQzoneFormReply } from '../src/web/qzone-form-reply';
import { forwardQzoneMsg, setQzoneTextPostVisibility } from '../src/web/qzone-write';

const cred = { uin: '10001', skey: 'synthetic', pskey: 'synthetic' };

/** 用一个假 fetch 收走请求，返回指定 body。 */
function transport(body: string): { url: string; init: RequestInit | undefined }[] {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(body);
  }) as typeof fetch;
  return calls;
}

afterEach(() => {
  // @ts-expect-error 测试环境恢复（Node 自带 fetch）
  globalThis.fetch = undefined;
});

function formBody(call: { init?: RequestInit }): URLSearchParams {
  return new URLSearchParams(String(call.init?.body ?? ''));
}

const textPost = {
  code: 0,
  tid: '112700000000000000000000',
  uin: cred.uin,
  content: '  原正文\n',
  conlist: [{ type: 2, con: '  原正文\n' }],
  ugc_right: 64,
  ugcright_id: 'fixture-right',
  t1_subtype: 1,
};

test('官方纯文本编辑表单原样保留正文，只在独立读回后确认权限', async () => {
  const methods: string[] = [];
  const full = { ...cred, cookie: 'uin=o10001; p_skey=synthetic; session=fixture' };
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    methods.push(method);
    if (method === 'POST') {
      assert.equal(url.host, 'user.qzone.qq.com');
      assert.match(url.pathname, /\/taotao\.qzone\.qq\.com\/cgi-bin\/emotion_cgi_update$/);
      assert.equal(new Headers(init?.headers).get('cookie'), full.cookie);
      const body = formBody({ init });
      assert.equal(body.get('con'), textPost.content);
      assert.equal(body.get('ugc_right'), '4');
      assert.equal(body.get('ugcright_id'), textPost.ugcright_id);
      assert.equal(body.get('richtype'), '');
      assert.equal(body.get('subrichtype'), '');
      assert.equal(body.has('pic_bo'), false);
      assert.equal(
        body.get('qzreferrer'),
        `https://user.qzone.qq.com/${cred.uin}/mood/${textPost.tid}`,
      );
      return new Response('<script>frameElement.callback({code:0,subcode:0});</script>');
    }
    return Response.json({ ...textPost, ugc_right: methods.length > 1 ? 4 : 64 });
  }) as typeof fetch;
  assert.deepEqual(await setQzoneTextPostVisibility(full, textPost.tid, 64, 4, () => {}), {
    state: 'confirmed',
    visibility: 4,
  });
  assert.deepEqual(methods, ['GET', 'POST', 'GET']);
});

test('当前权限已变化或存在媒体时停止整帖保存', async () => {
  const stale = transport(JSON.stringify({ ...textPost, ugc_right: 1 }));
  await assert.rejects(
    setQzoneTextPostVisibility(cred, textPost.tid, 64, 4, () => {}),
    /已变化/,
  );
  assert.equal(stale.length, 1);
  const rich = transport(JSON.stringify({ ...textPost, pic: [{ pic_id: 'fixture' }] }));
  await assert.rejects(
    setQzoneTextPostVisibility(cred, textPost.tid, 64, 4, () => {}),
    /纯文本/,
  );
  assert.equal(rich.length, 1);
});

// ────────────────────────── 回执解析 ──────────────────────────

test('JSONP 回执取第一个对象作为数据', () => {
  const data = parseQzoneFormReply('_Callback({code:0,result:{code:0,msg:"ok"}});');
  assert.equal(data.code, 0);
});

test('HTML formSender 回执只认 frameElement.callback', () => {
  const data = parseQzoneFormReply(
    '<!DOCTYPE html><html><body><script>document.domain="qq.com";frameElement.callback({result:{code:0,msg:"ok"}});</script></body></html>',
  );
  assert.deepEqual(data.result, { code: 0, msg: 'ok' });
});

test('parent.frameElement.callback 同样被识别', () => {
  const data = parseQzoneFormReply(
    '<html><body><script>try { parent.frameElement.callback({code:0}); } catch (e) {}</script></body></html>',
  );
  assert.equal(data.code, 0);
});

test('字符串里的伪回调不算回执', () => {
  assert.throws(
    () =>
      parseQzoneFormReply(
        '<html><script>var text="frameElement.callback({code:0})";</script></html>',
      ),
    /未确认/,
  );
});

test('注释里的伪回调不算回执', () => {
  assert.throws(
    () => parseQzoneFormReply('<html><script>// frameElement.callback({code:0})</script></html>'),
    /未确认/,
  );
  assert.throws(
    () =>
      parseQzoneFormReply('<html><script>/* frameElement.callback({code:0}) */</script></html>'),
    /未确认/,
  );
});

test('其它函数名不算回执', () => {
  assert.throws(
    () => parseQzoneFormReply('<html><script>other.callback({code:0});</script></html>'),
    /未确认/,
  );
});

test('只接受实际脚本里恰有一个对象实参的 FormSender 回调', () => {
  for (const html of [
    '<html><script>frameElement.callback({code:0}, null);</script></html>',
    '<html><!-- <script>frameElement.callback({code:0});</script> --></html>',
  ]) {
    assert.throws(() => parseQzoneFormReply(html), /未确认/);
  }
  assert.equal(
    parseQzoneFormReply('<script>parent["frameElement"]["callback"]({code:0});</script>').code,
    0,
  );
});

test('两个回调 / 零个回调都算结果未确认', () => {
  assert.throws(
    () =>
      parseQzoneFormReply(
        '<html><script>frameElement.callback({code:0});frameElement.callback({code:-1});</script></html>',
      ),
    /未确认/,
  );
  assert.throws(() => parseQzoneFormReply('<html><body>login</body></html>'), /未确认/);
});

test('实参不是对象字面量时拒绝（不执行远程代码）', () => {
  assert.throws(
    () =>
      parseQzoneFormReply('<html><script>frameElement.callback({code:evil()});</script></html>'),
    /无法解析|未确认/,
  );
});

test('带 src 的外链脚本不取，但内联脚本仍能作为回执', () => {
  const data = parseQzoneFormReply(
    '<html><script src="//evil/x.js"></script><script>frameElement.callback({code:0});</script></html>',
  );
  assert.equal(data.code, 0);

  // 只有外链、没有内联回执 → 结果未确认（绝不把远程脚本内容当数据）。
  assert.throws(
    () => parseQzoneFormReply('<html><script src="//evil/x.js"></script></html>'),
    /未确认/,
  );
});

// ────────────────────────── 转发请求 ──────────────────────────

test('转发用当前动态，不夹带评论转发参数', async () => {
  const calls = transport(JSON.stringify({ code: 0, result: { code: 0 } }));
  await forwardQzoneMsg(cred, '10004', 'current-post', '转发语');

  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /emotion_cgi_forward_v6\?g_tk=/);
  const body = formBody(calls[0]!);
  assert.equal(body.get('tid'), 'current-post');
  assert.equal(body.get('t1_uin'), '10004');
  assert.equal(body.get('con'), '转发语');
  assert.equal(body.get('with_cmt'), '0');
  assert.equal(body.get('fwdToWeibo'), '0');
  assert.equal(body.get('signin'), '0');
  assert.equal(body.get('hostuin'), '10001');
  assert.equal(body.get('format'), 'fs');
  assert.equal(body.has('t2_tid'), false);
  assert.equal(body.has('fwdtype'), false);
});

test('转发回执里的业务错误原样抛出，不重发', async () => {
  const calls = transport(
    '<html><script>frameElement.callback({code:-1,message:"合成业务错误"});</script></html>',
  );
  await assert.rejects(() => forwardQzoneMsg(cred, '10004', 'post', ''), /合成业务错误/);
  assert.equal(calls.length, 1);
});

test('needVerify / verifyurl 明确提示去空间验证', async () => {
  transport(JSON.stringify({ code: 0, data: { needVerify: 1 } }));
  await assert.rejects(() => forwardQzoneMsg(cred, '10004', 'post', ''), /QQ 空间完成验证/);

  transport(JSON.stringify({ code: 0, verifyurl: 'https://example.com/verify' }));
  await assert.rejects(() => forwardQzoneMsg(cred, '10004', 'post', ''), /QQ 空间完成验证/);
});

test('登录态失效抛 WebAuthError（好让 withRetry 换票）', async () => {
  for (const code of [-3000, -4009, -10001, -10003]) {
    transport(JSON.stringify({ code }));
    await assert.rejects(
      () => forwardQzoneMsg(cred, '10004', 'post', ''),
      (error: Error & { name?: string }) => error.name === 'WebAuthError',
      `code=${code} 应换票`,
    );
  }
  const calls = transport(JSON.stringify({ code: -10000, message: '使用人数过多' }));
  await assert.rejects(
    () => forwardQzoneMsg(cred, '10004', 'post', ''),
    (error: Error) => error.name !== 'WebAuthError' && error.message.includes('使用人数过多'),
  );
  assert.equal(calls.length, 1);
});

test('身份非法 / 转发语过长在联网前拒绝', async () => {
  const calls = transport(JSON.stringify({ code: 0 }));
  await assert.rejects(() => forwardQzoneMsg(cred, 'bad', 'post', ''), /身份无效/);
  await assert.rejects(() => forwardQzoneMsg(cred, '10004', 'a b', ''), /身份无效/);
  await assert.rejects(() => forwardQzoneMsg(cred, '10004', 'post', 'x'.repeat(4097)), /过长/);
  assert.equal(calls.length, 0);
});

test('beforeSend 抛错时不发请求', async () => {
  const calls = transport(JSON.stringify({ code: 0 }));
  await assert.rejects(
    () =>
      forwardQzoneMsg(cred, '10004', 'post', '', () => {
        throw new Error('审计失败');
      }),
    /审计失败/,
  );
  assert.equal(calls.length, 0);
});
