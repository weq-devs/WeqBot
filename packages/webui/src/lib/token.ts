/**
 * 访问令牌的前端侧规则：`wqb_` + 24 位 base62（生成规则见 TODO「P5 后端缺口 W2」）。
 *
 * 前端只做两件事：格式预检、从粘贴内容里抠出令牌。真正的校验永远在服务端。
 */

export const TOKEN_PREFIX = 'wqb_';

const WELL_FORMED = /^wqb_[0-9A-Za-z]{24}$/;
const EMBEDDED = /wqb_[0-9A-Za-z]{24}(?![0-9A-Za-z])/;

export function isWellFormedToken(value: string): boolean {
  return WELL_FORMED.test(value);
}

/** 用户常把整行终端输出（甚至好几行）一起复制过来：能抠出令牌就只留令牌。 */
export function extractToken(text: string): string | null {
  return EMBEDDED.exec(text)?.[0] ?? null;
}

let linkTokenTaken = false;

/**
 * 一键链接 `…/#token=wqb_…`：只在第一次调用时读，读完立刻从地址栏抹掉，
 * 免得令牌留在浏览器历史里。之后再调用一律返回 null。
 *
 * 放在 hash 里是因为 hash 不会发给服务端，也就不会进任何访问日志。
 */
export function takeLinkToken(): string | null {
  if (linkTokenTaken) return null;
  linkTokenTaken = true;

  const params = new URLSearchParams(window.location.hash.slice(1));
  const raw = params.get('token');
  if (raw === null) return null;

  params.delete('token');
  const rest = params.toString();
  const { pathname, search } = window.location;
  window.history.replaceState(null, '', `${pathname}${search}${rest ? `#${rest}` : ''}`);
  return extractToken(raw);
}
