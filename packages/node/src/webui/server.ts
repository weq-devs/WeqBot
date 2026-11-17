/**
 * WebUI 的 HTTP 服务地基（W1）。
 *
 * 职责刻意收得很窄：**只做路由与安全边界**，业务都在各自的路由模块里。
 *
 * 安全口径（每一条都是有人踩过的坑）：
 *
 * - **只监听回环**：默认 `127.0.0.1`。监听别的地址必须显式配置，且启动时告警 ——
 *   这个端口后面是完整的 QQ 账号能力。
 * - **Host 校验**：只认 `127.0.0.1:<port>` / `localhost:<port>`。防 DNS rebinding：
 *   攻击者的域名解析到 127.0.0.1 时，浏览器发来的 `Host` 会是他的域名。
 * - **写操作再校验 `Origin`**：`Origin` 缺失（同源导航）放行，存在则必须与 `Host` 同源。
 * - **CSP `default-src 'self'`**：页面里没有 inline script（主题初始化是外置文件），
 *   头像是后端代理的，所以不需要放行外网域名。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { createLogger, type Logger } from '@weqbot/common';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export interface WebUiServerOptions {
  host?: string;
  port: number;
  /** 交给业务的路由处理。返回 `false` 表示没匹配（继续走静态资源 / SPA）。 */
  handle(request: WebUiRequest): Promise<boolean> | boolean;
  /** 静态资源根目录（`packages/webui/dist`）。不存在时只提供 API。 */
  staticDir?: string;
  logger?: Logger;
}

export interface WebUiRequest {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  /** 只读的回环地址判断；监听非回环时这里仍按请求的 Host 判。 */
  loopback: boolean;
}

export interface WebUiServerHandle {
  readonly port: number;
  close(): Promise<void>;
}

export function createWebUiServer(options: WebUiServerOptions): {
  start(): Promise<WebUiServerHandle>;
} {
  const log = options.logger ?? createLogger('webui');
  const host = options.host ?? '127.0.0.1';
  const explicitNonLoopback = !LOOPBACK_HOSTS.has(host);

  if (explicitNonLoopback) {
    log.warn('WebUI 监听的不是回环地址，控制台可能被局域网访问', { host });
  }

  const server: Server = createServer((request, response) => {
    void handleRequest(request, response);
  });
  let port = options.port;

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    applySecurityHeaders(response);

    const rawHost = request.headers.host ?? '';
    const hostOk = isAcceptableHost(rawHost, port);
    if (!hostOk) {
      respondJson(response, 421, { code: 'HOST_REJECTED' });
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(request.url ?? '/', `http://${rawHost}`);
    } catch {
      respondJson(response, 400, { code: 'BAD_URL' });
      return;
    }

    if (parsed.pathname.startsWith('/api/')) {
      // 写操作校验 Origin：跨站表单 / fetch 会带上别人的 Origin，直接拒。
      if (isWriteMethod(request.method) && !isSameOrigin(request, rawHost)) {
        respondJson(response, 403, { code: 'ORIGIN_REJECTED' });
        return;
      }
      try {
        const handled = await options.handle({
          request,
          response,
          url: parsed,
          loopback: LOOPBACK_HOSTS.has(host),
        });
        if (handled) return;
      } catch (cause) {
        log.error('WebUI 请求处理失败', {
          path: parsed.pathname,
          cause: cause instanceof Error ? cause.message : String(cause),
        });
        // message 用固定文案：页面直接渲染它，裸 `INTERNAL` 只会让用户以为
        // 程序坏了却什么都做不了。细节在服务端日志里。
        if (!response.headersSent) {
          respondJson(response, 500, {
            code: 'INTERNAL',
            message: '控制台内部错误，详见控制台日志',
          });
        } else response.end();
        return;
      }
      respondJson(response, 404, { code: 'NOT_FOUND' });
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD' });
      response.end();
      return;
    }

    const served = await serveStatic(parsed.pathname, options.staticDir, response);
    if (served) return;
    // SPA 回退：只有 HTML 导航才回 index.html；带扩展名的静态资源缺失就该 404，
    // 否则一个加载失败的 `.js` 会返回 HTML，浏览器报「MIME 类型不对」的怪错。
    if (options.staticDir && !hasFileExtension(parsed.pathname)) {
      if (await serveSpaFallback(options.staticDir, response)) return;
    }
    respondJson(response, 404, { code: 'NOT_FOUND' });
  }

  function isAcceptableHost(hostHeader: string, listeningPort: number): boolean {
    if (!hostHeader) return false;
    // `localhost:6299` / `127.0.0.1:6299` / `[::1]:6299`
    const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(hostHeader);
    if (!match) return false;
    const hostname = match[1]!.toLowerCase();
    const hostPort = match[2] === undefined ? undefined : Number(match[2]);
    if (!LOOPBACK_HOSTS.has(hostname)) return false;
    // 没写端口时只接受默认端口（80）；写了就必须是实际监听端口。
    if (hostPort === undefined) return listeningPort === 80;
    return hostPort === listeningPort;
  }

  function isSameOrigin(request: IncomingMessage, hostHeader: string): boolean {
    const origin = request.headers.origin;
    if (origin === undefined) return true; // 同源导航 / curl 不发 Origin
    try {
      const url = new URL(origin);
      return url.host === hostHeader && (url.protocol === 'http:' || url.protocol === 'https:');
    } catch {
      return false;
    }
  }

  return {
    async start() {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port, host, () => {
          const address = server.address();
          port = typeof address === 'object' && address ? address.port : options.port;
          resolve();
        });
      });
      log.debug('WebUI 已启动', { host, port });
      return {
        get port() {
          return port;
        },
        async close() {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        },
      };
    },
  };
}

function isWriteMethod(method: string | undefined): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

/** CSP 里的 `img-src data:` 是给二维码（base64 PNG）用的；头像是同源代理。 */
function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "img-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; '),
  );
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cache-Control', 'no-store');
}

export function respondJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

/**
 * 静态资源。`staticDir` 不存在时返回 `false`（只有 API 能力的开发模式）。
 *
 * 路径穿越防护：解析后的绝对路径必须仍在 `staticDir` 下 —— 用 `resolve` 比较前缀，
 * 不靠字符串黑名单。
 */
function hasFileExtension(pathname: string): boolean {
  const last = pathname.slice(pathname.lastIndexOf('/') + 1);
  return /\.[a-z0-9]{1,10}$/i.test(last);
}

async function serveStatic(
  pathname: string,
  staticDir: string | undefined,
  response: ServerResponse,
): Promise<boolean> {
  if (!staticDir) return false;
  const root = resolve(staticDir);
  let relative: string;
  try {
    relative = decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    return false; // 非法百分号编码
  }
  const target = resolve(join(root, relative));
  if (target !== root && !target.startsWith(root + sep)) return false;

  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(target);
  } catch {
    return false;
  }
  if (!info.isFile()) return false;

  const type = CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream';
  const body = await readFile(target);
  // 带 hash 的构建产物可以长缓存；其余不缓存（更新后要立刻生效）。
  const immutable = /\/assets\/[^/]+\.[0-9a-f]{8,}\./.test(pathname);
  response.writeHead(200, {
    'content-type': type,
    'content-length': body.length,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  response.end(body);
  return true;
}

/** SPA 回退：读 `index.html`；读不到返回 `false` 让调用方走 404。 */
async function serveSpaFallback(staticDir: string, response: ServerResponse): Promise<boolean> {
  let body: Buffer;
  try {
    body = await readFile(join(staticDir, 'index.html'));
  } catch {
    return false;
  }
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-cache',
  });
  response.end(body);
  return true;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};
