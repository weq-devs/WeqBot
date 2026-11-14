/**
 * 前端与 `@weqbot/node` WebUI 服务之间的契约。
 *
 * 后端还没有（TODO「P5 后端缺口」），现在由 `mock.ts` 实现；后端落地时按这里的
 * 形状写 HTTP 实现，页面代码不需要动。每个方法注释里写了它对应的接口。
 */

/** `POST /api/auth/session` 的结果。 */
export type SessionResult =
  | { ok: true }
  /** 401 `TOKEN_INVALID`：令牌不对，还剩几次机会。 */
  | { ok: false; reason: 'invalid'; remainingAttempts: number }
  /** 429 `RATE_LIMITED`：失败太多次，锁定中。 */
  | { ok: false; reason: 'locked'; retryAfterMs: number }
  /** 请求根本没到服务端（进程退出 / 端口变了）。 */
  | { ok: false; reason: 'unreachable' };

export interface AuthApi {
  /**
   * `POST /api/auth/session {token}`：用访问令牌换 WebUI 会话，服务端写 HttpOnly cookie。
   * 不做「保持登录」：令牌随进程重启刷新，会话跟着浏览器走就够了。
   */
  createSession(token: string): Promise<SessionResult>;
  /** `GET /api/auth/session`：刷新页面后确认会话是否仍有效。 */
  getSession(): Promise<{ authenticated: boolean }>;
  /** `DELETE /api/auth/session`：退出控制台 —— 只清 WebUI 会话，**不让 QQ 账号下线**。 */
  deleteSession(): Promise<void>;
}

export interface Api {
  auth: AuthApi;
}
