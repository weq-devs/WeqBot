/**
 * 开发期 mock：模拟 WebUI 服务的行为（网络延迟、失败计数、锁定、进程离线）。
 *
 * 节奏与 TODO「P5 后端缺口 W2」约定的一致：连续 5 次失败锁 30 秒。
 * 会话放在 sessionStorage 里，模拟一个只在本次浏览器会话内有效的 cookie。
 */

import type { Api, SessionResult } from './types';

/** mock 服务认的令牌（开发面板可以一键复制）。 */
export const MOCK_TOKEN = 'wqb_8Kf2mQ7xLr4Tn9vB3cZp6hJd';

const MAX_ATTEMPTS = 5;
const LOCK_MS = 30_000;
const SESSION_KEY = 'weqbot.mock.session';

const state = { failures: 0, lockedUntil: 0, offline: false };
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** 开发面板用的开关。 */
export const mockControls = {
  isOffline: () => state.offline,
  setOffline(value: boolean): void {
    state.offline = value;
    notify();
  },
  /** 清掉失败次数与锁定。 */
  reset(): void {
    state.failures = 0;
    state.lockedUntil = 0;
    notify();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** 真实网络不会每次都一样快。 */
const latency = (base: number) => base + Math.round(Math.random() * base * 0.5);

async function createSession(token: string): Promise<SessionResult> {
  await sleep(latency(620));
  if (state.offline) return { ok: false, reason: 'unreachable' };

  const now = Date.now();
  if (state.lockedUntil > now) {
    return { ok: false, reason: 'locked', retryAfterMs: state.lockedUntil - now };
  }
  if (token !== MOCK_TOKEN) {
    state.failures += 1;
    if (state.failures >= MAX_ATTEMPTS) {
      state.failures = 0;
      state.lockedUntil = now + LOCK_MS;
      return { ok: false, reason: 'locked', retryAfterMs: LOCK_MS };
    }
    return { ok: false, reason: 'invalid', remainingAttempts: MAX_ATTEMPTS - state.failures };
  }

  state.failures = 0;
  sessionStorage.setItem(SESSION_KEY, '1');
  return { ok: true };
}

export const mockApi: Api = {
  auth: {
    createSession: (token) => createSession(token),
    async getSession() {
      await sleep(latency(90));
      if (state.offline) throw new Error('mock: 进程离线');
      const stored = sessionStorage.getItem(SESSION_KEY);
      return { authenticated: stored === '1' };
    },
    async deleteSession() {
      await sleep(latency(160));
      sessionStorage.removeItem(SESSION_KEY);
    },
  },
};
