/**
 * web 凭据来源（OIDB `0x102a_1` → ptlogin2 jump → `0x102a_0` 兜底）。
 *
 * 离线用例：fake native 回 OIDB 响应，fake fetch 回带 Set-Cookie 的跳转链。
 * 验的是「票怎么来」和缓存/失效语义 —— 真机验收见 TODO §12.8 P8.6。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encode } from '../src/protobuf';
import { FetchClientKey } from '../src/oidb/misc/fetch-client-key';
import { FetchPskeyOidb } from '../src/oidb/misc/fetch-pskey';
import { computeBkn, cookieHeader, withRetry, WebAuthError } from '../src/web/credential';
import { createOidbWebCredentials } from '../src/web/credentials-oidb';

const SESSION = 7;

interface Call {
  command: number;
  subCommand: number;
}

function clientKeyBytes(): Uint8Array {
  return encode(FetchClientKey.respSchema, {
    keyIndex: 19,
    clientKey: 'CLIENTKEY',
    expireTime: 1800,
  });
}

function pskeyBytes(domain: string, pskey: string): Uint8Array {
  return encode(FetchPskeyOidb.respSchema, { items: [{ domain, pskey, expireTime: 0 }] });
}

function fakeNative(
  calls: Call[],
  pskey: string | null,
): { sendOidbPacket: (...args: unknown[]) => Promise<Uint8Array> } {
  return {
    sendOidbPacket: async (...args: unknown[]) => {
      const [sessionId, command, subCommand] = args as [number, number, number];
      assert.equal(sessionId, SESSION);
      calls.push({ command, subCommand });
      if (command === 0x102a && subCommand === 1) return clientKeyBytes();
      if (command === 0x102a && subCommand === 0) {
        if (!pskey) throw new Error('no pskey');
        return pskeyBytes('qzone.qq.com', pskey);
      }
      throw new Error(`unexpected oidb ${command}_${subCommand}`);
    },
  };
}

function redirect(location: string, cookies: string[]): Response {
  const headers = new Headers({ location });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(null, { status: 302, headers });
}

/** 跳转链的终点：200 + Set-Cookie（没有 location）。 */
function landing(cookies: string[]): Response {
  const headers = new Headers();
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(null, { status: 200, headers });
}

test('bkn 是 djb2 31 位；cookieHeader 优先用完整 jar', () => {
  assert.equal(computeBkn(''), 5381);
  assert.equal(computeBkn('abc'), computeBkn('abc'));
  assert.ok(computeBkn('p_skey-value') <= 0x7fffffff);

  assert.equal(
    cookieHeader({ uin: '10001', skey: 'S', pskey: '' }),
    'uin=o10001; skey=S; p_uin=o10001',
  );
  assert.equal(
    cookieHeader({ uin: '10001', skey: 'S', pskey: 'P', cookie: 'a=1; b=2' }),
    'a=1; b=2',
  );
});

test('jump 链收齐 Set-Cookie，缺 p_skey 时回退 OIDB，第二次走缓存', async () => {
  const calls: Call[] = [];
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(url);
    if (urls.length === 1) {
      return redirect('https://ssl.ptlogin2.qq.com/step2', [
        'skey=SKEY123; Path=/',
        'pt4_token=T; Path=/',
      ]);
    }
    return landing(['p_skey=PSKEY123; Domain=.qq.com; Path=/', 'p_uin=o10001; Path=/']);
  }) as unknown as typeof fetch;

  const source = createOidbWebCredentials({
    native: fakeNative(calls, 'FALLBACK'),
    sessionId: SESSION,
    uin: '10001',
    fetchImpl,
  });

  const cred = await source.forDomain('qzone.qq.com');
  assert.equal(cred.uin, '10001');
  assert.equal(cred.skey, 'SKEY123');
  assert.equal(cred.pskey, 'PSKEY123');
  assert.match(cred.cookie ?? '', /pt4_token=T/);
  assert.match(cred.cookie ?? '', /p_skey=PSKEY123/);

  // jump URL 必须带 clientKey / keyIndex / clientuin。
  const jump = new URL(urls[0]!);
  assert.equal(jump.origin, 'https://ssl.ptlogin2.qq.com');
  assert.equal(jump.searchParams.get('clientkey'), 'CLIENTKEY');
  assert.equal(jump.searchParams.get('keyindex'), '19');
  assert.equal(jump.searchParams.get('clientuin'), '10001');

  // 第二次同域：不重新换票，也不重新请求。
  const again = await source.forDomain('qzone.qq.com');
  assert.equal(again.pskey, 'PSKEY123');
  assert.equal(urls.length, 2);
  assert.equal(calls.length, 1);
});

test('jar 里没有 p_skey 时回退 0x102a_0', async () => {
  const calls: Call[] = [];
  const fetchImpl = (async () => landing(['skey=ONLY_SKEY; Path=/'])) as unknown as typeof fetch;

  const source = createOidbWebCredentials({
    native: fakeNative(calls, 'OIDB_PSKEY'),
    sessionId: SESSION,
    uin: '10001',
    fetchImpl,
  });

  const cred = await source.forDomain('qzone.qq.com');
  assert.equal(cred.skey, 'ONLY_SKEY');
  assert.equal(cred.pskey, 'OIDB_PSKEY');
  assert.deepEqual(
    calls.map((call) => `${call.command}_${call.subCommand}`),
    ['4138_1', '4138_0'],
  );
});

test('invalidate 会清掉缓存并重新换票', async () => {
  const calls: Call[] = [];
  let hits = 0;
  const fetchImpl = (async () => {
    hits += 1;
    return landing([`skey=S${hits}; Path=/`, `p_skey=P${hits}; Path=/`]);
  }) as unknown as typeof fetch;

  const source = createOidbWebCredentials({
    native: fakeNative(calls, null),
    sessionId: SESSION,
    uin: '10001',
    fetchImpl,
  });

  assert.equal((await source.forDomain('qzone.qq.com')).pskey, 'P1');
  source.invalidate?.('qzone.qq.com');
  assert.equal((await source.forDomain('qzone.qq.com')).pskey, 'P2');
  assert.equal(hits, 2);
});

test('withRetry 只在 WebAuthError 时换票重试一次', async () => {
  let invalidated = 0;
  let attempts = 0;
  const source = {
    forDomain: async () => ({ uin: '1', skey: 's', pskey: 'p' }),
    invalidate: () => {
      invalidated += 1;
    },
  };

  const ok = await withRetry(source, 'qzone.qq.com', async () => 'ok');
  assert.equal(ok, 'ok');
  assert.equal(invalidated, 0);

  const result = await withRetry(source, 'qzone.qq.com', async () => {
    attempts += 1;
    if (attempts === 1) throw new WebAuthError('expired', -3000);
    return 'retried';
  });
  assert.equal(result, 'retried');
  assert.equal(invalidated, 1);
  assert.equal(attempts, 2);

  await assert.rejects(
    withRetry(source, 'qzone.qq.com', async () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal(invalidated, 1);
});
