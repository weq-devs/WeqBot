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

import { existsSync, readdirSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { BotOneBotConfig } from '@weqbot/bot';
import {
  configureLogging,
  createLogger,
  getLogDirectory,
  getLogFileLevel,
  getLogLevel,
  setLogLevel,
  type Logger,
  type LogLevel,
} from '@weqbot/common';
import {
  EMPTY_ONEBOT_CONFIG,
  maskOneBotConfig,
  OneBotConfigError,
  validateOneBotConfig,
} from '../onebot-config';
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
import { looksAbsolutePath, normalizeQqDataRoot, normalizeQqInstallDir } from './qq-normalize';
import { openSse } from './sse';

/** `qq.installDir` / `qq.dataDir` 的补丁：`null` 表示清除覆盖、回到自动探测。 */
export interface QqPathOverridesPatch {
  installDir?: string | null;
  dataDir?: string | null;
}

export interface WebUiRouteOptions {
  auth: WebUiAuth;
  console: ConsoleRuntime;
  observability: Observability;
  logger?: Logger;
  /** 保存 OneBot 配置的落盘点（`--config` 文件）。没有时配置只在内存生效。 */
  saveConfig?: (config: BotOneBotConfig) => Promise<void>;
  /** 保存手动指定的 QQ 路径（`qq.installDir` / `qq.dataDir`）。没有时只在内存生效。 */
  saveQqPaths?: (patch: QqPathOverridesPatch) => Promise<void>;
  /** 读取当前 OneBot 配置（给网络页）。 */
  readConfig: () => BotOneBotConfig | undefined;
  /** `--config` 路径；设置页只展示，不在这里写。 */
  configPath?: string;
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

      // ── 健康检查：免鉴权（页面只关心进程还在不在）──
      //
      // 页面每几秒轮询一次。进程退出后这个请求会直接失败，页面据此把「在线
      // 47 分钟」换成「连接已断开」—— 不能看着一个早就死掉的进程继续累计时长。
      // 不依赖会话：后端重启后 cookie 失效，健康状态仍然应该能被看见。
      if (path === '/api/health') {
        requireMethod(request, 'GET');
        response.setHeader('cache-control', 'no-store');
        return ok(response, {
          ok: true,
          at: Date.now(),
          pid: process.pid,
          uptimeSec: Math.round(process.uptime()),
        });
      }

      // ── 以下全部要会话 ──
      requireSession(request);

      if (path === '/api/events') return streamEvents(request, response);

      if (path === '/api/login/environment') {
        requireMethod(request, 'GET');
        return ok(response, await runtime.environment(wantsRefresh(url)));
      }

      if (path === '/api/login/accounts') {
        requireMethod(request, 'GET');
        return ok(response, { accounts: await runtime.accounts() });
      }

      if (path === '/api/login/instances') {
        requireMethod(request, 'GET');
        return ok(response, await runtime.attachSnapshot());
      }

      if (path === '/api/login/attach') {
        requireMethod(request, 'POST');
        const body = await readJson<{ uin?: unknown; pid?: unknown; password?: unknown }>(request);
        const uin = typeof body.uin === 'string' ? body.uin.trim() : '';
        if (!uin) throw new HttpError(400, 'BAD_UIN', '缺少 uin');

        let pid: number | undefined;
        if (body.pid !== undefined && body.pid !== null) {
          const parsed = typeof body.pid === 'number' ? body.pid : Number(body.pid);
          if (!Number.isInteger(parsed) || parsed <= 0) {
            throw new HttpError(400, 'BAD_PID', 'pid 不合法');
          }
          pid = parsed;
        }

        // 提权密码：只在本次请求的栈上活一次 —— 不进日志、不进配置、不进 vault。
        // 长度上限只是防把请求体当传输带；空串等于没给（用户点了取消）。
        const password =
          typeof body.password === 'string' && body.password.length > 0 ? body.password : undefined;
        if (password !== undefined && password.length > 1024) {
          throw new HttpError(400, 'BAD_PASSWORD', '密码过长');
        }

        const result = await runtime.attachAccount(uin, {
          ...(pid !== undefined ? { pid } : {}),
          ...(password !== undefined ? { password } : {}),
        });
        return ok(response, { phase: runtime.currentPhase, pid: result.pid });
      }

      if (path === '/api/login/start') {
        requireMethod(request, 'POST');
        const body = await readJson<{ uin?: unknown; group?: unknown }>(request);
        const uin = typeof body.uin === 'string' ? body.uin.trim() : '';
        if (!uin) throw new HttpError(400, 'BAD_UIN', '缺少 uin');
        // `group` 决定用哪**组**账号：本机组每次从 `login.db` 现解 a1、复用本机
        // uid / guid；自主组用 vault 里那份自持 guid 的凭据。页面列表里同一个 uin
        // 可能在两组里各有一条，点哪条就必须用哪组 —— 否则本机账号会拿着自主组
        // 的 guid 去换票（服务端当换设备），反之亦然。省略时按「有自主凭据就自主」
        // 推断。
        const group = body.group;
        if (group !== undefined && group !== 'local' && group !== 'self') {
          throw new HttpError(400, 'BAD_GROUP', 'group 只接受 "local" / "self"');
        }
        const result = await runtime.startAccount(uin, group ? { group } : {});
        // `endedQq`：登录前结束的本机 QQ 进程数（QQ 本体正用着这个账号时不为 0）。
        return ok(response, { phase: runtime.currentPhase, endedQq: result.endedQq });
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

      if (path === '/api/settings') {
        if (request.method === 'GET') {
          return ok(response, await settingsSnapshot(wantsRefresh(url)));
        }
        if (request.method === 'PUT') {
          const body = await readJson<{
            logDir?: unknown;
            level?: unknown;
            qzone?: unknown;
            qqPaths?: unknown;
            refresh?: unknown;
          }>(request);
          if (body.logDir !== undefined) {
            if (body.logDir !== null && typeof body.logDir !== 'string') {
              throw new HttpError(400, 'BAD_LOG_DIR', 'logDir 必须是字符串或 null');
            }
            const raw = typeof body.logDir === 'string' ? body.logDir.trim() : '';
            const dir = !raw || raw.toLowerCase() === 'off' ? null : raw;
            configureLogging({ dir });
            log.info('日志目录已切换', { dir: dir ?? 'off' });
          }
          if (body.level !== undefined) {
            if (!isLogLevel(body.level)) {
              throw new HttpError(400, 'BAD_LOG_LEVEL', '未知的日志级别');
            }
            setLogLevel(body.level);
            log.info('终端日志级别已切换', { level: body.level });
          }
          if (body.qzone !== undefined) {
            if (typeof body.qzone !== 'boolean') {
              throw new HttpError(400, 'BAD_QZONE', 'qzone 必须是布尔值');
            }
            const current = options.readConfig() ?? EMPTY_ONEBOT_CONFIG;
            const next = { ...current, qzone: body.qzone };
            // qzone 决定后端是否换取空间凭据 / 注册 action，必须重建 OneBot 后端。
            await runtime.currentBot?.reloadOneBot(next);
            await options.saveConfig?.(next);
            log.info('QQ 空间能力已切换', { qzone: body.qzone });
          }
          if (body.qqPaths !== undefined) {
            const patch = parseQqPathsPatch(body.qqPaths);
            // 先落盘再改内存：写文件失败时运行时保持原样，否则用户会看到
            // 「设置生效了」但重启后又变回去。
            await options.saveQqPaths?.(patch);
            runtime.setQqPathOverrides(mergeQqPathOverrides(runtime, patch));
            log.info('QQ 路径已更新', { installDir: patch.installDir, dataDir: patch.dataDir });
          }
          const refresh = body.refresh === true;
          return ok(response, await settingsSnapshot(refresh));
        }
        throw new HttpError(405, 'METHOD_NOT_ALLOWED');
      }

      if (path === '/api/onebot/config') {
        if (request.method === 'GET') {
          // 没配置过 OneBot 时也给一份空骨架：网络页要能直接「添加」并保存，
          // 而不是拿到 undefined 后连草稿都建不出来。
          return ok(response, {
            config: maskOneBotConfig(options.readConfig() ?? EMPTY_ONEBOT_CONFIG),
          });
        }
        if (request.method === 'PUT') {
          const body = await readJson<{ config?: unknown }>(request);
          let config: BotOneBotConfig;
          try {
            config = validateOneBotConfig(body.config, options.readConfig());
          } catch (cause) {
            if (cause instanceof OneBotConfigError) {
              throw new HttpError(400, cause.code, cause.message);
            }
            throw cause;
          }
          await runtime.currentBot?.reloadOneBot(config);
          await options.saveConfig?.(config);
          return ok(response, { config: maskOneBotConfig(config) });
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

  async function settingsSnapshot(refresh = false): Promise<{
    environment: Awaited<ReturnType<ConsoleRuntime['environment']>>;
    account: { uin: string } | null;
    onebot: { qzone: boolean };
    /** 当前生效的手动路径（设置页预填输入框）；没设就是 null。 */
    qqPaths: { installDir: string | null; dataDir: string | null };
    logging: {
      dir: string | null;
      level: LogLevel;
      fileLevel: LogLevel;
      files: Array<{ name: string; size: number }>;
    };
    runtime: {
      platform: NodeJS.Platform;
      arch: string;
      node: string;
      pid: number;
      uptimeSec: number;
      configPath: string | null;
    };
  }> {
    const dir = getLogDirectory();
    const overrides = runtime.qqPathOverrides ?? {};
    return {
      environment: await runtime.environment(refresh),
      account: runtime.boundUin ? { uin: runtime.boundUin } : null,
      onebot: { qzone: options.readConfig()?.qzone !== false },
      qqPaths: {
        installDir: overrides.installDir ?? null,
        dataDir: overrides.dataDir ?? null,
      },
      logging: {
        dir,
        level: getLogLevel(),
        fileLevel: getLogFileLevel(),
        files: listLogFiles(dir),
      },
      runtime: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        pid: process.pid,
        uptimeSec: Math.round(process.uptime()),
        configPath: options.configPath ?? null,
      },
    };
  }

  // ─────────────────────────── QQ 路径 ───────────────────────────

  /** `?refresh=1` / `?refresh=true`：跳过路径缓存。 */
  function wantsRefresh(url: URL): boolean {
    const value = url.searchParams.get('refresh');
    return value === '1' || value === 'true';
  }

  /**
   * 校验设置页提交的 QQ 路径。
   *
   * 三道关：类型 → 绝对路径 → 归一化后仍存在。归一化很重要：用户从文件选择器里
   * 点进 `<root>/<uin>` 或 `resources/app` 是常见手滑，直接报错会让人以为不支持。
   */
  function parseQqPathsPatch(value: unknown): QqPathOverridesPatch {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new HttpError(400, 'BAD_QQ_PATHS', 'qqPaths 必须是对象');
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key !== 'installDir' && key !== 'dataDir') {
        throw new HttpError(400, 'BAD_QQ_PATHS', `qqPaths 里不认识的键 "${key}"`);
      }
    }

    const patch: QqPathOverridesPatch = {};
    for (const key of ['installDir', 'dataDir'] as const) {
      if (!(key in record)) continue;
      const raw = record[key];
      if (raw === null) {
        patch[key] = null;
        continue;
      }
      if (typeof raw !== 'string') {
        throw new HttpError(400, 'BAD_QQ_PATHS', `${key} 必须是字符串或 null`);
      }
      const trimmed = raw.trim();
      // 空串等价于「清除」：前端清空输入框后点应用就是这个形状。
      if (!trimmed) {
        patch[key] = null;
        continue;
      }
      if (!looksAbsolutePath(trimmed)) {
        throw new HttpError(
          400,
          'BAD_QQ_PATHS',
          `${key} 必须是绝对路径（收到 "${trimmed}"）：相对路径会按服务进程的 cwd 解析，含义不确定`,
        );
      }
      const normalized =
        key === 'installDir'
          ? normalizeQqInstallDir(trimmed, process.platform)
          : normalizeQqDataRoot(trimmed, process.platform);
      if (!existsSync(normalized)) {
        const hint =
          normalized === trimmed
            ? `路径不存在：${normalized}`
            : `路径不存在：${normalized}（已按目录层级从 "${trimmed}" 归一化而来）`;
        throw new HttpError(400, 'BAD_QQ_PATHS', `${key} ${hint}`);
      }
      patch[key] = normalized;
    }
    return patch;
  }

  /** 把补丁合并到当前覆盖上（`undefined` 保持不变，`null` 清除）。 */
  function mergeQqPathOverrides(
    runtime: ConsoleRuntime,
    patch: QqPathOverridesPatch,
  ): { installDir?: string | null; dataDir?: string | null } | null {
    const current = runtime.qqPathOverrides ?? {};
    const next: { installDir?: string | null; dataDir?: string | null } = { ...current };
    if (patch.installDir !== undefined) {
      if (patch.installDir === null) delete next.installDir;
      else next.installDir = patch.installDir;
    }
    if (patch.dataDir !== undefined) {
      if (patch.dataDir === null) delete next.dataDir;
      else next.dataDir = patch.dataDir;
    }
    return Object.keys(next).length > 0 ? next : null;
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

function isLogLevel(value: unknown): value is LogLevel {
  return (
    value === 'trace' ||
    value === 'debug' ||
    value === 'info' ||
    value === 'warn' ||
    value === 'error'
  );
}

/** 日志目录下最近的文件（设置页展示用）；目录不存在时返回空表。 */
function listLogFiles(dir: string | null): Array<{ name: string; size: number }> {
  if (!dir) return [];
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.log'))
      .sort()
      .slice(-12)
      .map((name) => {
        try {
          return { name, size: statSync(join(dir, name)).size };
        } catch {
          return { name, size: 0 };
        }
      });
  } catch {
    return [];
  }
}
