/**
 * WeqBot 自己的 web 凭据来源：**纯 OIDB + HTTP，不需要 attach，也不需要本地 pt_login**。
 *
 * 链路（与 SnowLuma `core/src/bridge/apis/web.ts` 的 `getCookies` 同款）：
 *
 *   1. OIDB `0x102a_1`（{@link FetchClientKey}）拿 clientKey / keyIndex；
 *   2. `https://ssl.ptlogin2.qq.com/jump` 跳转链，把每一跳的 `Set-Cookie` 收成 jar；
 *   3. jar 里没有 `p_skey` 时回退 OIDB `0x102a_0`（{@link FetchPskeyOidb}）。
 *
 * 为什么不走 `pt_login`：WeqBot 的 mode2 会话本来就没有 QQ 进程，也没有本地认证端口；
 * 「免 attach、只走 pt_login」是 WeQ 宿主的能力，通过 {@link WebCredentialSource}
 * 注入，见 TODO §12.8.3 D18。
 *
 * 缓存语义刻意不按时间猜 TTL：按域缓存，cgi 判票据失效时由 `withRetry` 调
 * `invalidate` 重取（与 WeQ 现有行为一致）。
 */

import { FetchClientKey } from '../oidb/misc/fetch-client-key';
import { FetchPskeyOidb } from '../oidb/misc/fetch-pskey';
import type { OidbNative } from '../transport';
import type { WebCredential, WebCredentialSource } from './credential';

/** `ssl.ptlogin2.qq.com/jump` 的默认落点（无业务专属 u1 时用）。 */
const DEFAULT_LANDING = 'https://h5.qzone.qq.com/qqnt/qzoneinpcqq/friend?refresh=0';

const JUMP_ENDPOINT = 'https://ssl.ptlogin2.qq.com/jump';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

export interface OidbWebCredentialOptions {
  native: OidbNative;
  /** 会话句柄（协议层沿用了搬运时的 `pid` 命名，语义就是 sessionId）。 */
  sessionId: number;
  /** 账号 uin（十进制串）。 */
  uin: string;
  /** 测试可替换；默认用全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** 覆盖 ptlogin2 落点（少数域需要特定 u1）。 */
  landingUrl?: string;
}

function cookiePairs(setCookie: readonly string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const line of setCookie) {
    const first = line.split(';', 1)[0] ?? '';
    const index = first.indexOf('=');
    if (index <= 0) continue;
    const name = first.slice(0, index).trim();
    const value = first.slice(index + 1).trim();
    if (name) pairs.push([name, value]);
  }
  return pairs;
}

function setCookieHeaders(response: Response): string[] {
  const withGetSetCookie = response.headers as Headers & {
    getSetCookie?: () => string[];
  };
  const all = withGetSetCookie.getSetCookie?.();
  if (all && all.length > 0) return all;
  const single = response.headers.get('set-cookie');
  return single ? [single] : [];
}

/**
 * 走完 ptlogin2 jump 的跳转链，收集每一跳的 Set-Cookie。
 *
 * 必须手动跟跳转：`redirect: 'follow'` 会把中间跳的 `Set-Cookie` 丢掉，而
 * `pt4_token` / `RK` / `ptcz` 恰恰只在中间跳出现 —— 缺了它们空间 cgi 会回 `-10000`。
 */
async function collectCookieJar(
  url: string,
  fetchImpl: typeof fetch,
): Promise<Map<string, string>> {
  const jar = new Map<string, string>();
  let current = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetchImpl(current, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        ...(jar.size > 0 ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    for (const [name, value] of cookiePairs(setCookieHeaders(response))) {
      jar.set(name, value);
    }

    const location = response.headers.get('location');
    if (!location) return jar;
    current = new URL(location, current).toString();
  }

  return jar;
}

function jumpUrl(uin: string, clientKey: string, keyIndex: string, landing: string): string {
  const params = new URLSearchParams({
    ptlang: '1033',
    clientuin: uin,
    clientkey: clientKey,
    u1: landing,
    keyindex: keyIndex,
  });
  return `${JUMP_ENDPOINT}?${params.toString()}`;
}

function jarToHeader(jar: Map<string, string>): string {
  return [...jar]
    .filter(([, value]) => value !== '')
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

/**
 * 建一个绑定在某条 SSO 会话上的凭据来源。
 *
 * `domain` 用裸域名（`qzone.qq.com` / `qun.qq.com`），不要带协议与路径。
 */
export function createOidbWebCredentials(options: OidbWebCredentialOptions): WebCredentialSource {
  const { native, sessionId, uin } = options;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const landing = options.landingUrl ?? DEFAULT_LANDING;

  let skey: string | null = null;
  const pskeyByDomain = new Map<string, string>();
  const cookieByDomain = new Map<string, string>();

  async function fetchForDomain(domain: string): Promise<WebCredential> {
    const clientKey = await FetchClientKey.invoke(native, sessionId);
    const jar = await collectCookieJar(
      jumpUrl(uin, clientKey.clientKey, clientKey.keyIndex, landing),
      fetchImpl,
    );

    const jarSkey = jar.get('skey') ?? '';
    if (jarSkey) skey = jarSkey;
    const effectiveSkey = jarSkey || skey || '';

    let pskey = jar.get('p_skey') ?? '';
    if (!pskey) {
      try {
        pskey = await FetchPskeyOidb.invoke(native, sessionId, domain);
      } catch {
        pskey = '';
      }
    }
    if (!pskey) {
      throw new Error(`未能取得 ${domain} 的 p_skey（ptlogin2 jump 与 0x102a_0 都没给）`);
    }

    const cookie = jar.size > 0 ? jarToHeader(jar) : undefined;
    pskeyByDomain.set(domain, pskey);
    if (cookie) cookieByDomain.set(domain, cookie);
    return { uin, skey: effectiveSkey, pskey, ...(cookie ? { cookie } : {}) };
  }

  return {
    async forDomain(domain: string): Promise<WebCredential> {
      const cachedPskey = pskeyByDomain.get(domain);
      if (cachedPskey) {
        const cookie = cookieByDomain.get(domain);
        return {
          uin,
          skey: skey ?? '',
          pskey: cachedPskey,
          ...(cookie ? { cookie } : {}),
        };
      }
      return fetchForDomain(domain);
    },

    invalidate(domain: string): void {
      skey = null;
      pskeyByDomain.delete(domain);
      cookieByDomain.delete(domain);
    },
  };
}
