/**
 * 礼物商城执行层（2026-11-16 从 WeQ `account/web/gift_mall.ts` 补入）。
 *
 * 验的是请求形状 / 回包校验 / 写操作不重试；真机验收见 TODO §12.8 P8.6。
 */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  buildGiftMallSendRequest,
  fetchGiftMallGiftList,
  fetchGiftMallHomePageExtraInfo,
  fetchGiftMallWall,
  submitGiftMallBuyItem,
} from '../src/web/gift-mall-exec';

const cred = { uin: '10001', skey: 'synthetic', pskey: 'synthetic' };

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function transport(bodies: unknown[]): Call[] {
  const calls: Call[] = [];
  let index = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const body = bodies[Math.min(index++, bodies.length - 1)];
    return new Response(JSON.stringify(body));
  }) as typeof fetch;
  return calls;
}

afterEach(() => {
  // @ts-expect-error 测试环境恢复（Node 自带 fetch）
  globalThis.fetch = undefined;
});

test('首页请求打到 club.vip.qq.com 的 trpc 端点，带 g_tk 与 Kuikly UA', async () => {
  const calls = transport([{ wishList: [], crowdRecomList: [], tabList: [''], crowdTab: '' }]);
  await fetchGiftMallHomePageExtraInfo(cred, 20002);

  assert.equal(calls.length, 1);
  const url = new URL(calls[0]!.url);
  assert.equal(url.host, 'club.vip.qq.com');
  assert.match(url.pathname, /GiftMall\/GetHomePageExtraInfo$/);
  assert.match(url.search, /g_tk=\d+/);
  const headers = calls[0]!.init?.headers as Record<string, string>;
  assert.match(headers['User-Agent']!, /V1_AND_SQ_/);
  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), { data: { to_uin: 20002 } });
});

test('列表响应缺游标 / 结束标记时报错，不返回半成品', async () => {
  transport([{ giftList: [] }]);
  await assert.rejects(() => fetchGiftMallGiftList(cred, 20002), /缺少游标或结束标记/);

  transport([{ giftList: [] }]);
  await assert.rejects(() => fetchGiftMallGiftList(cred, 20002), /缺少游标或结束标记/);
});

test('业务错误码透出 message；-10000 抛 WebAuthError', async () => {
  transport([{ code: 100, message: '礼物不存在' }]);
  await assert.rejects(() => fetchGiftMallGiftList(cred, 20002), /礼物不存在/);

  transport([{ code: -10000, message: 'expired' }]);
  await assert.rejects(
    () => fetchGiftMallGiftList(cred, 20002),
    (error: Error & { name?: string }) => error.name === 'WebAuthError',
  );
});

test('礼物墙校验 extInfo / isEnd / beginTime 三项', async () => {
  transport([{ giftsList: [], isEnd: true, extInfo: '', beginTime: 0 }]);
  const ok = await fetchGiftMallWall(cred, { isSend: true, beginTime: 0, batchInfo: '' });
  assert.equal(ok.isEnd, true);

  transport([{ giftsList: [] }]);
  await assert.rejects(
    () => fetchGiftMallWall(cred, { isSend: true, beginTime: 0, batchInfo: '' }),
    /缺少游标或时间字段/,
  );
});

test('下单打到 act.qzone.qq.com，且网络失败只发一次（不重放订单）', async () => {
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts += 1;
    throw new Error('synthetic timeout');
  }) as unknown as typeof fetch;

  const request = buildGiftMallSendRequest({
    gift: { giftId: 100, giftPrice: 520, svipDiscount: 500 },
    senderUin: 10001,
    toUin: 20002,
    message: '生日快乐',
    timestampMs: 1_700_000_000_000,
  });
  // 传输层把原始 cause 包成 WebRequestError，这里只断言「确实失败了」。
  await assert.rejects(() => submitGiftMallBuyItem(cred, request), /网络请求失败|timeout/);
  assert.equal(attempts, 1);
});

test('下单请求体：itemId / itemSubId / itemExtendInfo 与价格一致', () => {
  const request = buildGiftMallSendRequest({
    gift: { giftId: 100, giftPrice: 520, svipDiscount: 500 },
    senderUin: 10001,
    toUin: 20002,
    message: '生日快乐',
    needAnonymous: true,
    timestampMs: 1_700_000_000_000,
  });
  assert.equal(request.item_id, '100');
  assert.equal(request.format, 'json');
  const item = request.itemList[0]!;
  assert.equal(item.itemId, '100');
  assert.match(item.itemSubId, /giftPrice:520/);
  assert.match(item.itemSubId, /anonymous:1/);
  assert.match(item.itemSubId, /uin:10001/);
  assert.match(item.itemSubId, /uin:20002/);
  const extend = JSON.parse(item.itemExtendInfo);
  assert.equal(extend.gift_id, 100);
  assert.equal(extend.gift_prize, 500);
  assert.equal(extend.wish_desc, '生日快乐');
  assert.equal(extend.sender_uin, 10001);
  assert.equal(extend.receive_uin, 20002);
  assert.equal(extend.need_anonymous, true);
});

test('缺 giftPrice / svipDiscount 时在构造阶段就拒绝', () => {
  assert.throws(
    () =>
      buildGiftMallSendRequest({
        gift: { giftId: 100, svipDiscount: 500 },
        senderUin: 10001,
        toUin: 20002,
      }),
    /giftPrice/,
  );
  assert.throws(
    () =>
      buildGiftMallSendRequest({
        gift: { giftId: 100, giftPrice: 520 },
        senderUin: 10001,
        toUin: 20002,
      }),
    /svipDiscount/,
  );
});

test('下单成功回执缺 data 时判为格式异常', async () => {
  transport([{ code: 0 }]);
  const request = buildGiftMallSendRequest({
    gift: { giftId: 100, giftPrice: 520, svipDiscount: 500 },
    senderUin: 10001,
    toUin: 20002,
  });
  await assert.rejects(() => submitGiftMallBuyItem(cred, request), /响应格式异常/);
});
