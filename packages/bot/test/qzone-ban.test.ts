import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createOneBotAdapter } from '@weqbot/onebot';
import { computeBkn, createProtocolClient } from '@weqbot/protocol';
import type { NativePort } from '@weqbot/wire';
import { createProtocolBackend } from '../src/onebot-backend';

const SELF_UIN = '10001';
const TARGET_UIN = 10002;
const SKEY = 'synthetic';
const OK_HTML =
  '<html><script>document.domain="qq.com";frameElement.callback({code:0,subcode:0});</script></html>';

async function startAdapter(t: TestContext) {
  const backend = createProtocolBackend({
    protocol: createProtocolClient({ native: {} as NativePort, sessionId: 7 }),
    selfUin: SELF_UIN,
    webCredentials: {
      forDomain: async () => ({ uin: SELF_UIN, skey: SKEY, pskey: '' }),
    },
  });
  const adapter = createOneBotAdapter({
    config: { networks: { httpServers: [], httpClients: [], wsServers: [], wsClients: [] } },
    backend,
    selfId: Number(SELF_UIN),
    events: { on: () => () => {} },
    heartbeatMs: 0,
  });
  t.after(() => adapter.stop());
  await adapter.start();
  return adapter;
}

test('set_qzone_ban 通过共用禁访接口增删单人并接收 HTML 回执', async (t) => {
  const fetch = t.mock.method(
    globalThis,
    'fetch',
    async (..._args: Parameters<typeof globalThis.fetch>) => new Response(OK_HTML),
  );
  const adapter = await startAdapter(t);
  for (const [params, action] of [
    [{ user_id: TARGET_UIN }, '1'],
    [{ user_id: TARGET_UIN, enable: false }, '2'],
  ] as const) {
    assert.deepEqual(await adapter.call('set_qzone_ban', params), {
      status: 'ok',
      retcode: 0,
      data: null,
    });
    const [url, init] = fetch.mock.calls.at(-1)!.arguments;
    assert.equal(new URL(String(url)).host, 'user.qzone.qq.com');
    assert.match(String(url), /\/cgi_black_action_new$/);
    assert.equal(init?.method, 'POST');
    const form = new URLSearchParams(String(init?.body));
    assert.equal(form.get('uin'), SELF_UIN);
    assert.equal(form.get('act_uin'), String(TARGET_UIN));
    assert.equal(form.get('action'), action);
    assert.equal(form.get('g_tk'), String(computeBkn(SKEY)));
  }
  assert.equal(fetch.mock.callCount(), 2);
});

test('禁访明确拒绝或缺少回执时返回失败且只写一次', async (t) => {
  const adapter = await startAdapter(t);
  const params = { user_id: TARGET_UIN };
  for (const [body, expected] of [
    ['<script>frameElement.callback({code:0,subcode:7,msg:"合成拒绝"});</script>', /合成拒绝/],
    ['<script>const text = "frameElement.callback({code:0})";</script>', /未确认/],
    ['<script>frameElement.callback({code:0}, null);</script>', /未确认/],
    ['{"name":"synthetic"}', /未确认/],
  ] as const) {
    const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(body));
    const result = await adapter.call('set_qzone_ban', params);
    assert.equal((result as { status: string }).status, 'failed');
    assert.match(JSON.stringify(result), expected);
    assert.equal(fetch.mock.callCount(), 1);
    fetch.mock.restore();
  }
});
