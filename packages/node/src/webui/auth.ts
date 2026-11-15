/**
 * WebUI 访问令牌与会话（W2）。
 *
 * 判断口径：
 *
 * - **令牌只存在内存里**，每次启动重新生成。它不是凭据、不落盘，所以丢了只影响
 *   「这次浏览器会话」，重启后终端会打印新的。
 * - **比较是常量时间的**：令牌 24 位 base62，用 `crypto.timingSafeEqual` 比，
 *   避免按失败字节数泄露前缀。
 * - **会话 cookie 是 HttpOnly + SameSite=Strict**，前端拿不到也不该拿到；
 *   它不是 QQ 凭据，只是「这台浏览器已通过令牌验证」。
 * - **失败 5 次锁 30 秒**，锁定期间不发「还剩几次」—— 那等于告诉攻击者还能试几次。
 */

import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

const TOKEN_PREFIX = 'wqb_';
const TOKEN_BODY_LENGTH = 24;
const MAX_ATTEMPTS = 5;
const LOCK_MS = 30_000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_MAX_AGE_REMEMBER_MS = 7 * 24 * 60 * 60 * 1000;

/** base62：不含容易看错的大小写混淆字符也不影响（令牌是粘贴的，不需要人读）。 */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export interface AuthSession {
  /** cookie 值（32 字节 hex）。 */
  id: string;
  /** 过期时刻（ms）。 */
  expiresAt: number;
  /** 是否「保持登录」；只影响浏览器 cookie 的 Max-Age 表现。 */
  remember: boolean;
  createdAt: number;
}

export type AuthResult =
  | { ok: true; session: AuthSession; remember: boolean }
  | { ok: false; reason: 'invalid'; remainingAttempts: number }
  | { ok: false; reason: 'locked'; retryAfterMs: number };

/**
 * 一份进程内令牌 + 会话表。
 *
 * 没有定时清理：会话表最多几十条（一个浏览器几条），过期判定在 `resolve` 里做，
 * 顺手删掉过期的。不落盘（TODO W2 的待定项按「不持久化」实现，最简单也最安全）。
 */
export class WebUiAuth {
  private readonly token: string;
  private readonly tokenBytes: Buffer;
  private readonly sessions = new Map<string, AuthSession>();
  private failures = 0;
  private lockedUntil = 0;

  constructor(token?: string) {
    this.token = token ?? generateToken();
    this.tokenBytes = Buffer.from(this.token, 'utf8');
  }

  /** 明文令牌；只在启动时打印到终端，永不进日志 / 响应体。 */
  get plainToken(): string {
    return this.token;
  }

  /** 用令牌换会话。`now` 可注入，测试锁定时长用。 */
  createSession(candidate: string, remember: boolean, now = Date.now()): AuthResult {
    if (this.lockedUntil > now) {
      return { ok: false, reason: 'locked', retryAfterMs: this.lockedUntil - now };
    }

    if (!this.matches(candidate)) {
      this.failures += 1;
      if (this.failures >= MAX_ATTEMPTS) {
        this.failures = 0;
        this.lockedUntil = now + LOCK_MS;
        return { ok: false, reason: 'locked', retryAfterMs: LOCK_MS };
      }
      return { ok: false, reason: 'invalid', remainingAttempts: MAX_ATTEMPTS - this.failures };
    }

    this.failures = 0;
    this.lockedUntil = 0;
    const session: AuthSession = {
      id: randomBytes(32).toString('hex'),
      expiresAt:
        now + (remember ? Math.max(SESSION_TTL_MS, SESSION_MAX_AGE_REMEMBER_MS) : SESSION_TTL_MS),
      remember,
      createdAt: now,
    };
    this.sessions.set(session.id, session);
    return { ok: true, session, remember };
  }

  /** 当前时刻的锁定剩余（ms）；未锁定时 0。 */
  lockRemainingMs(now = Date.now()): number {
    return this.lockedUntil > now ? this.lockedUntil - now : 0;
  }

  /** 按 cookie 值判会话是否有效；顺带清掉过期条目。 */
  resolve(sessionId: string | undefined, now = Date.now()): AuthSession | undefined {
    if (!sessionId) return undefined;
    this.prune(now);
    return this.sessions.get(sessionId);
  }

  /** 退出控制台：只删这条会话，不下线 QQ 账号。 */
  revoke(sessionId: string | undefined): void {
    if (sessionId) this.sessions.delete(sessionId);
  }

  /** 当前有效会话数（总览 / 诊断用）。 */
  sessionCount(now = Date.now()): number {
    this.prune(now);
    return this.sessions.size;
  }

  private matches(candidate: string): boolean {
    // 长度不同时仍跑一次比较，避免「长度不对」也被时间差看出来。
    const actual = Buffer.from(candidate, 'utf8');
    const expected = this.tokenBytes;
    const length = Math.max(actual.length, expected.length);
    const a = Buffer.alloc(length);
    const b = Buffer.alloc(length);
    actual.copy(a);
    expected.copy(b);
    const equal = timingSafeEqual(a, b);
    return equal && actual.length === expected.length;
  }

  private prune(now: number): void {
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id);
    }
  }
}

/** `wqb_` + 24 位 base62，用 CSPRNG（`randomInt` 拒绝采样，无模偏）。 */
export function generateToken(): string {
  let body = '';
  for (let i = 0; i < TOKEN_BODY_LENGTH; i++) {
    body += ALPHABET[randomInt(0, ALPHABET.length)];
  }
  return `${TOKEN_PREFIX}${body}`;
}

/** 令牌形状检查（前端也用它做提交前的早失败，不替代服务端比较）。 */
export function looksLikeToken(value: string): boolean {
  return /^wqb_[0-9A-Za-z]{24}$/.test(value.trim());
}

/** `POST /api/auth/session` 的 cookie 参数。 */
export const SESSION_COOKIE = 'wqb_session';

export function sessionCookie(
  session: AuthSession,
  now = Date.now(),
): { name: string; value: string; attributes: string[] } {
  const attributes = ['HttpOnly', 'SameSite=Strict', 'Path=/'];
  // 「保持登录」才给 Max-Age；否则是浏览器会话 cookie。
  if (session.remember) {
    attributes.push(`Max-Age=${Math.floor((session.expiresAt - now) / 1000)}`);
  }
  return { name: SESSION_COOKIE, value: session.id, attributes };
}

export { MAX_ATTEMPTS, LOCK_MS, TOKEN_PREFIX, TOKEN_BODY_LENGTH };
