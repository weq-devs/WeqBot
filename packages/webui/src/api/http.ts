/**
 * 真 HTTP 客户端。所有端点都在 `/api/*` 同源（开发期由 vite 代理到 6099）。
 *
 * 三个约定：
 *
 * - **cookie 自动带**（同源请求浏览器默认行为），前端不保存任何令牌；
 * - 401 统一抛 `ApiError(401, 'UNAUTHENTICATED')`，由调用方决定回令牌页还是提示；
 * - 非 JSON 响应（服务没起 / 反代返回 HTML）也抛 `ApiError`，不把 HTML 当数据。
 */

import {
  ApiError,
  type ActionCallEntry,
  type ActionRunResult,
  type ActionsSnapshot,
  type Api,
  type ConsoleStateEvent,
  type LoginAccount,
  type LoginEnvironment,
  type LogEntry,
  type LogStats,
  type OneBotConfig,
  type Overview,
  type PushEventEntry,
  type QrSnapshot,
  type SessionResult,
  type SettingsSnapshot,
  type StreamName,
} from './types';

/** 后端没起 / 端口变了时 `fetch` 直接 reject —— 与 401 区分开。 */
async function request<T>(
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: init.method ?? 'GET',
      credentials: 'same-origin',
      headers: init.body === undefined ? {} : { 'content-type': 'application/json' },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      ...(init.signal ? { signal: init.signal } : {}),
    });
  } catch (cause) {
    throw new ApiError(0, 'UNREACHABLE', cause instanceof Error ? cause.message : '无法连接控制台');
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    throw new ApiError(response.status, 'BAD_RESPONSE', '服务返回了非 JSON 响应');
  }

  if (!response.ok) {
    const record = (payload ?? {}) as { code?: unknown; message?: unknown };
    throw new ApiError(
      response.status,
      typeof record.code === 'string' ? record.code : 'HTTP_ERROR',
      typeof record.message === 'string' ? record.message : undefined,
    );
  }
  return payload as T;
}

/** 打开一条 SSE；返回关闭函数。断线由浏览器自己重连。 */
function openStream(
  path: string,
  handlers: Record<string, (data: unknown) => void>,
  onError?: () => void,
): () => void {
  const source = new EventSource(path, { withCredentials: true });
  for (const [event, handler] of Object.entries(handlers)) {
    source.addEventListener(event, (message) => {
      try {
        handler(JSON.parse((message as MessageEvent<string>).data) as unknown);
      } catch {
        // 单条坏数据不该把整条流打断。
      }
    });
  }
  source.onerror = () => onError?.();
  return () => source.close();
}

export const httpApi: Api = {
  auth: {
    async createSession(token, remember = false): Promise<SessionResult> {
      let response: Response;
      try {
        response = await fetch('/api/auth/session', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token, remember }),
        });
      } catch {
        return { ok: false, reason: 'unreachable' };
      }
      if (response.status === 204) return { ok: true };
      const payload = (await response.json().catch(() => ({}))) as {
        code?: string;
        remainingAttempts?: number;
        retryAfterMs?: number;
      };
      if (payload.code === 'RATE_LIMITED') {
        return { ok: false, reason: 'locked', retryAfterMs: payload.retryAfterMs ?? 30_000 };
      }
      return {
        ok: false,
        reason: 'invalid',
        remainingAttempts: payload.remainingAttempts ?? 0,
      };
    },
    async getSession() {
      try {
        return await request<{ authenticated: boolean }>('/api/auth/session');
      } catch (cause) {
        // 服务没起时按「未登录」处理，让用户看到令牌页而不是白屏。
        if (cause instanceof ApiError && cause.status === 0) return { authenticated: false };
        throw cause;
      }
    },
    deleteSession: () => request<void>('/api/auth/session', { method: 'DELETE' }),
  },

  login: {
    environment: () => request<LoginEnvironment>('/api/login/environment'),
    async accounts() {
      const body = await request<{ accounts: LoginAccount[] }>('/api/login/accounts');
      return body.accounts;
    },
    start: (uin) => request<void>('/api/login/start', { method: 'POST', body: { uin } }),
    startQr: () => request<QrSnapshot>('/api/login/qr', { method: 'POST', body: {} }),
    cancelQr: () => request<void>('/api/login/qr', { method: 'DELETE' }),
  },

  overview: {
    get: () => request<Overview>('/api/overview'),
  },

  network: {
    async get() {
      const body = await request<{ config?: OneBotConfig }>('/api/onebot/config');
      // 旧服务端在「从未配置过 OneBot」时不返回 config。这里补一份空骨架，
      // 否则网络页拿不到草稿，点「添加」不会有任何反应。
      return body.config ?? { networks: emptyNetworks() };
    },
    async save(config) {
      const body = await request<{ config: OneBotConfig }>('/api/onebot/config', {
        method: 'PUT',
        body: { config },
      });
      return body.config;
    },
  },

  settings: {
    get: () => request<SettingsSnapshot>('/api/settings'),
    update: (patch) => request<SettingsSnapshot>('/api/settings', { method: 'PUT', body: patch }),
  },

  logs: {
    stats: () => request<LogStats>('/api/logs/stats'),
    stream(stream, handlers) {
      return openStream(
        `/api/logs/stream?stream=${stream}`,
        { [stream]: (entry) => handlers.onEntry(entry) },
        handlers.onError,
      );
    },
  },

  debug: {
    actions() {
      return request<ActionsSnapshot>('/api/actions');
    },
    run: (name, params) =>
      request<ActionRunResult>(`/api/actions/${encodeURIComponent(name)}`, {
        method: 'POST',
        body: { params },
      }),
  },

  account: {
    logout: (options: { forgetCredential?: boolean } = {}) =>
      request<void>('/api/account/logout', {
        method: 'POST',
        body: { forgetCredential: options.forgetCredential === true },
      }),
  },

  events: {
    subscribe(handlers) {
      return openStream(
        '/api/events',
        {
          console: (data) => handlers.onConsole(data as ConsoleStateEvent),
          logs: (data) => handlers.onEntry?.('logs', data as LogEntry),
          actions: (data) => handlers.onEntry?.('actions', data as ActionCallEntry),
          events: (data) => handlers.onEntry?.('events', data as PushEventEntry),
        },
        handlers.onError,
      );
    },
  },
};

export type { StreamName };

/** 网络页的空骨架：四类网络都要在，`draft` 才能建起来。 */
function emptyNetworks(): OneBotConfig['networks'] {
  return { httpServers: [], httpClients: [], wsServers: [], wsClients: [] };
}
