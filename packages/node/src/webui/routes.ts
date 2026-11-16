/**
 * WebUI 的全部路由（W1–W9）。
 *
 * 组织方式是「一个 `handle()` 里按路径前缀分发」，不引框架：路由只有十几条，
 * 且 `packages/node` 的产物要能塞进 WeqBot 的 `resources/bot-runtime/`，每多一个
 * 运行时依赖就多一份体积。
 *
 * 鉴权分层：
 *
 * - `/api/auth/*`：只有 `POST` 换会话需要令牌，其余看 cookie；
 * - `/api/avatar/*`：**免鉴权**（`<img>` 发不了 cookie 之外的凭据，而它只是公开头像）；
 * - 其余 `/api/*`：必须带有效会话 cookie，否则 401。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BotOneBotConfig } from '@weqbot/bot';
import { createLogger, type Logger } from '@weqbot/common';
import type { WebUiAuth } from './auth';
import { looksLikeToken, SESSION_COOKIE, sessionCookie } from './auth';
import type { ConsoleRuntime } from './console';
import {
  appendSetCookie,
  guard,
  HttpError,
  noContent,
  ok,
  readCookie,
  readJson,
  requireMethod,
} from './http-util';
import type { Observability, StreamName } from './observability';
import { openSse } from './sse';

export interface WebUiRouteOptions {
  auth: WebUiAuth;
  console: ConsoleRuntime;
  observability: Observability;
  logger?: Logger;
  /** 保存 OneBot 配置的落盘点（`--config` 文件）。没有时配置只在内存生效。 */
  saveConfig?: (config: BotOneBotConfig) => Promise<void>;
  /** 读取当前 OneBot 配置（给网络页）。 */
  readConfig: () => BotOneBotConfig | undefined;
}

export function createWebUiRouter(options: WebUiRouteOptions): {
  handle(input: { request: IncomingMessage; response: ServerResponse; url: URL }): Promise<boolean>;
} {
  const log = options.logger ?? createLogger('webui');
  const { auth, console: runtime } = options;

  /** 当前请求的会话 id（无效时为 undefined）。 */
  function sessionOf(request: IncomingMessage): string | undefined {
    const id = readCookie(request, SESSION_COOKIE);
    return auth.resolve(id) ? id : undefined;
  }

  function requireSession(request: IncomingMessage): void {
    if (!sessionOf(request)) throw new HttpError(401, 'UNAUTHENTICATED', '未登录控制台');
  }

  async function handle(input: {
    request: IncomingMessage;
    response: ServerResponse;
    url: URL;
  }): Promise<boolean> {
    const { request, response, url } = input;
    const path = url.pathname;

    // ── 头像代理：免鉴权（公开图片，且 `<img>` 不参与 cookie 之外的手势）──
    if (path.startsWith('/api/avatar/')) {
      return guard(response, () => serveAvatar(url, response));
    }

    if (!path.startsWith('/api/')) return false;

    return guard(response, async () => {
      // ── 鉴权 ──
      if (path === '/api/auth/session') {
        if (request.method === 'POST') return createSession(request, response);
        if (request.method === 'GET') {
          return ok(response, { authenticated: Boolean(sessionOf(request)) });
        }
        if (request.method === 'DELETE') {
          auth.revoke(sessionOf(request));
          appendSetCookie(
            response,
            `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`,
          );
          return noContent(response);
        }
        throw new HttpError(405, 'METHOD_NOT_ALLOWED');
      }

      // ── 以下全部要会话 ──
      requireSession(request);

      if (path === '/api/events') return streamEvents(request, response);

      if (path === '/api/login/environment') {
        requireMethod(request, 'GET');
        return ok(response, await runtime.environment());
      }

      if (path === '/api/login/accounts') {
        requireMethod(request, 'GET');
        return ok(response, { accounts: await runtime.accounts() });
      }

      if (path === '/api/login/start') {
        requireMethod(request, 'POST');
        const body = await readJson<{ uin?: unknown }>(request);
        const uin = typeof body.uin === 'string' ? body.uin.trim() : '';
        if (!uin) throw new HttpError(400, 'BAD_UIN', '缺少 uin');
        await runtime.startAccount(uin);
        return ok(response, { phase: runtime.currentPhase });
      }

      if (path === '/api/login/qr') {
        if (request.method === 'POST') return ok(response, await runtime.startQrLogin());
        if (request.method === 'DELETE') {
          runtime.cancelQrLogin();
          return noContent(response);
        }
        throw new HttpError(405, 'METHOD_NOT_ALLOWED');
      }

      if (path === '/api/overview') {
        requireMethod(request, 'GET');
        return ok(response, runtime.overview());
      }

      if (path === '/api/onebot/config') {
        if (request.method === 'GET') {
          // 没配置过 OneBot 时也给一份空骨架：网络页要能直接「添加」并保存，
          // 而不是拿到 undefined 后连草稿都建不出来。
          return ok(response, { config: maskConfig(options.readConfig() ?? EMPTY_ONEBOT_CONFIG) });
        }
        if (request.method === 'PUT') {
          const body = await readJson<{ config?: unknown }>(request);
          const config = validateOneBotConfig(body.config);
          await runtime.currentBot?.reloadOneBot(config);
          await options.saveConfig?.(config);
          return ok(response, { config: maskConfig(config) });
        }
        throw new HttpError(405, 'METHOD_NOT_ALLOWED');
      }

      if (path === '/api/logs/stream') {
        requireMethod(request, 'GET');
        const stream = url.searchParams.get('stream') ?? 'logs';
        if (!isStreamName(stream)) throw new HttpError(400, 'BAD_STREAM', '未知的日志流');
        return streamLogs(request, response, stream, url.searchParams.get('since'));
      }

      if (path === '/api/logs/stats') {
        requireMethod(request, 'GET');
        return ok(response, {
          actions: options.observability.stats(),
          logs: { total: options.observability.logs.size },
          events: { total: options.observability.events.size },
        });
      }

      if (path === '/api/actions') {
        requireMethod(request, 'GET');
        // 空列表有两种完全不同的原因：账号不在线，或账号在线但 OneBot 没启用。
        // 页面需要这个区分，否则只能看到一句误导性的「账号不在线」。
        return ok(response, {
          actions: listActions(runtime),
          phase: runtime.currentPhase,
          onebot: Boolean(runtime.currentBot?.onebot),
        });
      }

      const actionMatch = /^\/api\/actions\/([A-Za-z0-9_]+)$/.exec(path);
      if (actionMatch) {
        requireMethod(request, 'POST');
        return runAction(request, response, actionMatch[1]!);
      }

      if (path === '/api/account/logout') {
        requireMethod(request, 'POST');
        const body = await readJson<{ forgetCredential?: unknown }>(request);
        await runtime.logout({ forgetCredential: body.forgetCredential === true });
        return ok(response, { phase: runtime.currentPhase });
      }

      return false;
    });
  }

  // ─────────────────────────── 鉴权 ───────────────────────────

  function createSession(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    return (async () => {
      const body = await readJson<{ token?: unknown; remember?: unknown }>(request);
      const token = typeof body.token === 'string' ? body.token.trim() : '';
      if (!looksLikeToken(token)) {
        // 形状不对不必进比较、也不计入失败次数 —— 那是参数错误，不是猜令牌。
        throw new HttpError(400, 'TOKEN_MALFORMED', '令牌格式不对');
      }
      const remember = body.remember === true;
      const result = auth.createSession(token, remember);
      if (result.ok) {
        const cookie = sessionCookie(result.session);
        appendSetCookie(
          response,
          `${cookie.name}=${cookie.value}; ${cookie.attributes.join('; ')}`,
        );
        log.info('WebUI 会话已建立');
        return noContent(response);
      }
      if (result.reason === 'locked') {
        response.setHeader('retry-after', Math.ceil(result.retryAfterMs / 1000));
        return ok(response, { code: 'RATE_LIMITED', retryAfterMs: result.retryAfterMs }, 429);
      }
      log.warn('访问令牌错误', { remainingAttempts: result.remainingAttempts });
      return ok(
        response,
        { code: 'TOKEN_INVALID', remainingAttempts: result.remainingAttempts },
        401,
      );
    })();
  }

  // ─────────────────────────── SSE ───────────────────────────

  function streamEvents(request: IncomingMessage, response: ServerResponse): boolean {
    const client = openSse(request, response);
    const offs = [
      // 控制台阶段 / 扫码进度。
      runtime.consoleEvents.on('console', (event) => client.send('console', event)),
      // 三条观测流的增量。
      options.observability.subscribe((stream, entry) => client.send(stream, entry)),
    ];
    const cleanup = (): void => {
      for (const off of offs) off();
      client.close();
    };
    request.on('close', cleanup);
    response.on('close', cleanup);
    // 先给一份当前阶段，页面不用等第一次迁移。
    client.send('console', { phase: runtime.currentPhase, at: Date.now() });
    return true;
  }

  function streamLogs(
    request: IncomingMessage,
    response: ServerResponse,
    stream: StreamName,
    since: string | null,
  ): boolean {
    const client = openSse(request, response);
    const lastTs = since ? Number(since) : undefined;
    // 先把缓冲里的补上（页面刷新 / 断线重连后不丢历史）。
    const backlog =
      stream === 'logs'
        ? options.observability.logs.list(lastTs)
        : stream === 'actions'
          ? options.observability.actions.list(lastTs)
          : options.observability.events.list(lastTs);
    for (const entry of backlog) client.send(stream, entry);

    const off = options.observability.subscribe((name, entry) => {
      if (name === stream) client.send(stream, entry);
    });
    const cleanup = (): void => {
      off();
      client.close();
    };
    request.on('close', cleanup);
    response.on('close', cleanup);
    return true;
  }

  // ─────────────────────────── action ───────────────────────────

  /**
   * 调试页的 action 列表。
   *
   * 没有可用 OneBot 适配器时（账号未上线）返回空表 —— 那说明这些 action 现在
   * 一条都调不了，比列一堆只能 1404 的条目更有用。
   */
  function listActions(runtime: ConsoleRuntime): Array<{
    name: string;
    summary: string;
    group: string;
    write: boolean;
  }> {
    const bot = runtime.currentBot;
    const adapter = bot?.onebot;
    if (!adapter) return [];
    const docs = new Map(adapter.describe().map((doc) => [doc.name, doc]));
    return adapter.actions().map((name) => {
      const doc = docs.get(name);
      return {
        name,
        summary: doc?.summary ?? '',
        group: doc?.group ?? 'other',
        write: doc?.write ?? false,
      };
    });
  }

  async function runAction(
    request: IncomingMessage,
    response: ServerResponse,
    name: string,
  ): Promise<boolean> {
    const adapter = runtime.currentBot?.onebot;
    if (!adapter) {
      // 在线但没有 OneBot 时别报「不在线」：那会把用户引到错误的排查方向。
      throw new HttpError(
        409,
        'NOT_ONLINE',
        runtime.currentPhase === 'online'
          ? '账号在线，但 OneBot 网络未启用；请到「网络」页添加网络并保存'
          : '账号不在线，没有可执行的 action',
      );
    }
    if (!adapter.actions().includes(name)) {
      throw new HttpError(404, 'NO_ACTION', `未知的 action：${name}`);
    }
    const body = await readJson<{ params?: unknown }>(request);
    const params =
      body.params && typeof body.params === 'object' && !Array.isArray(body.params)
        ? (body.params as Record<string, unknown>)
        : {};

    const started = Date.now();
    const result = (await adapter.call(name, params as never)) as {
      status?: string;
      retcode?: number;
      data?: unknown;
      wording?: string;
    };
    const latencyMs = Date.now() - started;
    options.observability.recordAction({
      ts: started,
      action: name,
      params,
      retcode: result.retcode ?? -1,
      status: result.status === 'ok' ? 'ok' : 'failed',
      latencyMs,
      transport: 'webui',
      client: 'webui',
    });
    return ok(response, {
      status: result.status ?? 'failed',
      retcode: result.retcode ?? -1,
      data: result.data ?? null,
      ...(result.wording ? { wording: result.wording } : {}),
      latencyMs,
    });
  }

  // ─────────────────────────── 头像 ───────────────────────────

  /**
   * 头像代理：`q1.qlogo.cn` 只接受 uin 参数。
   *
   * 只放行纯数字 uin，避免把这里变成任意 URL 的 SSRF 跳板；上游失败时返回
   * 一个 404，前端 `<img>` 会显示占位。
   */
  async function serveAvatar(url: URL, response: ServerResponse): Promise<boolean> {
    const uin = decodeURIComponent(url.pathname.slice('/api/avatar/'.length));
    if (!/^[1-9]\d{4,19}$/.test(uin)) throw new HttpError(400, 'BAD_UIN', 'uin 不合法');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    timer.unref?.();
    try {
      // 上游 URL 由运行时决定：login.db 里有签名 URL 就用它（否则部分账号只能拿到默认头像），
      // 没有就退化成公开接口。**只接受 qlogo 系域名**，避免这个端点变成 SSRF 跳板。
      const upstreamUrl = runtime.avatarSource(uin);
      if (!/^https:\/\/[a-z0-9.-]*qlogo\.cn\//i.test(upstreamUrl)) {
        throw new HttpError(400, 'BAD_AVATAR_SOURCE');
      }
      const upstream = await fetch(upstreamUrl, {
        signal: controller.signal,
        redirect: 'error',
      });
      if (!upstream.ok) {
        response.writeHead(404);
        response.end();
        return true;
      }
      const bytes = Buffer.from(await upstream.arrayBuffer());
      response.writeHead(200, {
        'content-type': upstream.headers.get('content-type') ?? 'image/png',
        'content-length': bytes.length,
        'cache-control': 'private, max-age=3600',
      });
      response.end(bytes);
      return true;
    } catch {
      response.writeHead(404);
      response.end();
      return true;
    } finally {
      clearTimeout(timer);
    }
  }

  return { handle };
}

function isStreamName(value: string): value is StreamName {
  return value === 'logs' || value === 'actions' || value === 'events';
}

/** 未配置 OneBot 时网络页使用的空骨架（`networks` 四类都要在）。 */
const EMPTY_ONEBOT_CONFIG: BotOneBotConfig = {
  networks: { httpServers: [], httpClients: [], wsServers: [], wsClients: [] },
};

/** `GET /api/onebot/config` 把 accessToken 打码；`PUT` 时原样保留（见 `validateOneBotConfig`）。 */
function maskConfig(config: BotOneBotConfig | undefined): BotOneBotConfig | undefined {
  if (!config) return undefined;
  const mask = <T extends { accessToken?: string }>(item: T): T =>
    item.accessToken ? { ...item, accessToken: '***' } : item;
  return {
    ...config,
    networks: {
      httpServers: config.networks.httpServers.map(mask),
      httpClients: config.networks.httpClients.map(mask),
      wsServers: config.networks.wsServers.map(mask),
      wsClients: config.networks.wsClients.map(mask),
    },
  };
}

/**
 * 校验 `PUT /api/onebot/config` 的请求体。
 *
 * 不信任前端的任何字段：逐类检查数组与必填项。`accessToken: '***'` 会被当成
 * 「没改」—— 页面拿到的就是打码值，直接写回会把它变成字面量 `***`。
 */
function validateOneBotConfig(value: unknown): BotOneBotConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'BAD_CONFIG', 'config 必须是对象');
  }
  const record = value as Record<string, unknown>;
  const networks = record.networks as Record<string, unknown> | undefined;
  if (!networks || typeof networks !== 'object' || Array.isArray(networks)) {
    throw new HttpError(400, 'BAD_CONFIG', '缺少 networks');
  }
  const normalized = {
    httpServers: normalizeNetworks(networks.httpServers, 'httpServers'),
    httpClients: normalizeNetworks(networks.httpClients, 'httpClients'),
    wsServers: normalizeNetworks(networks.wsServers, 'wsServers'),
    wsClients: normalizeNetworks(networks.wsClients, 'wsClients'),
  } as BotOneBotConfig['networks'];

  // 端口唯一性：同一台机器上两个监听抢同一个端口是最常见的配置错误。
  const ports = new Set<number>();
  for (const server of [...normalized.httpServers, ...normalized.wsServers]) {
    if (server.enabled === false) continue;
    if (ports.has(server.port)) {
      throw new HttpError(400, 'PORT_CONFLICT', `端口 ${server.port} 被重复占用`);
    }
    ports.add(server.port);
  }

  return {
    networks: normalized,
    ...(record.qzone === false ? { qzone: false } : {}),
    ...(typeof record.qzoneDomain === 'string' ? { qzoneDomain: record.qzoneDomain } : {}),
  };
}

function normalizeNetworks<T extends { accessToken?: string }>(value: unknown, label: string): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new HttpError(400, 'BAD_CONFIG', `${label} 必须是数组`);
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new HttpError(400, 'BAD_CONFIG', `${label}[${index}] 必须是对象`);
    }
    const record = { ...(item as Record<string, unknown>) };
    if (record.accessToken === '***') delete record.accessToken;
    if (typeof record.name !== 'string' || !record.name.trim()) {
      throw new HttpError(400, 'BAD_CONFIG', `${label}[${index}] 缺少 name`);
    }
    if (record.port !== undefined && (typeof record.port !== 'number' || record.port < 0)) {
      throw new HttpError(400, 'BAD_CONFIG', `${label}[${index}].port 必须是非负整数`);
    }
    if (record.messageFormat !== 'array' && record.messageFormat !== 'string') {
      record.messageFormat = 'array';
    }
    if (typeof record.reportSelfMessage !== 'boolean') record.reportSelfMessage = true;
    return record as T;
  });
}
