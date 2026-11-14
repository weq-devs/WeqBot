/**
 * qq.com web cgi 的凭据契约。
 *
 * **这里只定义「业务层要什么」，不实现「票从哪来」**（D18）。三种来源：
 *
 *   1. `createOidbWebCredentials`（`./credentials-oidb`）—— WeqBot 自己的运行时；
 *      OIDB `0x102a_1` → ptlogin2 jump → `0x102a_0` 兜底，不依赖 QQ 进程。
 *   2. WeQ 宿主注入 —— `ptFetchCredentials`（含「免 attach、只走本地 pt_login」那条）。
 *   3. 测试桩。
 *
 * 业务代码（`qzone*.ts`）只认 {@link WebCredential} 与 {@link WebCredentialSource}。
 *
 * 搬运自 WeQ `packages/service/src/account/web/credential.ts`（2026-11-14）：
 * 只保留纯函数与类型，native / 落盘 / 日志依赖全部去掉。
 */

/** djb2 hash → 31-bit `bkn`（a.k.a. `g_tk` / csrf token），QQ web 的算法。 */
export function computeBkn(key: string): number {
  let hash = 5381;
  for (let i = 0; i < key.length; i++) {
    hash += (hash << 5) + key.charCodeAt(i);
  }
  return hash & 0x7fffffff;
}

/** The per-account tokens a web cgi needs, before they're joined into a header. */
export interface WebCredential {
  /** Raw uin, WITHOUT the leading 'o'（query 参数里是裸号）。 */
  uin: string;
  /** ptlogin2 skey。 */
  skey: string;
  /** 目标域的 p_skey。只拿到 skey 时可以为空。 */
  pskey: string;
  /**
   * ptlogin2 jump 收到的完整 cookie jar（含 pt4_token / RK / ptcz 等风控 cookie）。
   * 存在时 {@link cookieHeader} 优先发它 —— 手拼四字段会被空间风控甩 `-10000`。
   */
  cookie?: string;
}

/**
 * Assemble the `Cookie` header a qq.com web cgi expects. 优先用 jump 收到的完整 jar；
 * 没有时回退 `uin/skey/p_uin/p_skey` 四字段。`uin` / `p_uin` 带惯例的 'o' 前缀。
 */
export function cookieHeader(cred: WebCredential): string {
  if (cred.cookie) return cred.cookie;
  const jar: Record<string, string> = {
    uin: `o${cred.uin}`,
    skey: cred.skey,
    p_uin: `o${cred.uin}`,
    p_skey: cred.pskey,
  };
  return Object.entries(jar)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

/**
 * 业务层唯一依赖的凭据来源。
 *
 * 实现方负责缓存与刷新；`invalidate` 由 {@link withRetry} 在 cgi 判定票据失效时调用，
 * 位置在 `source` 上而不是业务代码里 —— 业务代码不需要知道票是怎么来的。
 */
export interface WebCredentialSource {
  /** 取 `domain`（如 `qzone.qq.com`、`qun.qq.com`）可用的凭据。 */
  forDomain(domain: string): Promise<WebCredential>;
  /** cgi 说票据不对时清掉该域缓存，下一次 `forDomain` 重新取。 */
  invalidate?(domain: string): void;
}

/**
 * cgi 包装函数在「这些凭据不行」时抛这个，{@link withRetry} 据此决定值得重试 —
 * 解析失败或 500 不值得。QQ 的 web cgi 用 HTTP 200 + body 里的错误码
 * （-3000 / -10000 / 光 message）表达，所以每个调用方都得自己判自己的 body 形状。
 */
export class WebAuthError extends Error {
  constructor(
    message: string,
    /** cgi 自己的错误码，给日志用。 */
    readonly code?: number,
  ) {
    super(message);
    this.name = 'WebAuthError';
  }
}

/**
 * 用 `domain` 的凭据跑 `fn`；抛 {@link WebAuthError} 就清缓存重跑**一次**。
 *
 * 只重试一次：新票也被拒说明不是过期问题（没登录 / 风控 / 没权限），再打只是徒劳。
 * 注意**写操作不要用它**：写请求失败重放可能产生重复内容，见 TODO §12.8 P8.4。
 */
export async function withRetry<T>(
  creds: WebCredentialSource,
  domain: string,
  fn: (cred: WebCredential) => Promise<T>,
  beforeSend?: () => void,
): Promise<T> {
  const send = async () => {
    const credential = await creds.forDomain(domain);
    beforeSend?.();
    return fn(credential);
  };
  try {
    return await send();
  } catch (e) {
    if (!(e instanceof WebAuthError)) throw e;
    creds.invalidate?.(domain);
    return send();
  }
}
