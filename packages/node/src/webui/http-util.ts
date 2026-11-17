/**
 * WebUI 路由共用的请求 / 响应小工具。
 *
 * 刻意不引框架：控制台的路由只有十几条，手写 `if` 比拉一个框架更清楚，也不会
 * 在打包时给 `bot.mjs` 增加依赖（`packages/node` 的产物要能塞进 WeqBot 的
 * `resources/bot-runtime/`）。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { respondJson } from './server';

/** `POST` 的 JSON body 上限：控制台只发配置与 action 参数，1 MiB 足够。 */
const MAX_BODY_BYTES = 1024 * 1024;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'HttpError';
  }
}

export async function readJson<T = Record<string, unknown>>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, 'BODY_TOO_LARGE', '请求体过大');
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {} as T;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    throw new HttpError(400, 'BAD_JSON', '请求体不是合法 JSON');
  }
}

/** 读 cookie（只需要一个名字，不引 cookie-parser）。 */
export function readCookie(request: IncomingMessage, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

export function appendSetCookie(response: ServerResponse, cookie: string): void {
  const existing = response.getHeader('set-cookie');
  if (existing === undefined) response.setHeader('set-cookie', cookie);
  else if (Array.isArray(existing)) response.setHeader('set-cookie', [...existing, cookie]);
  else response.setHeader('set-cookie', [String(existing), cookie]);
}

export function ok(response: ServerResponse, body: unknown, status = 200): true {
  respondJson(response, status, body);
  return true;
}

export function noContent(response: ServerResponse): true {
  response.writeHead(204);
  response.end();
  return true;
}

/**
 * 未预期异常的**固定**文案。
 *
 * 不能说 `cause.message`（内部错误里可能有路径 / uin / 上游错误串），但也
 * **不能只给一个 `INTERNAL`** —— 页面会把它原样渲染成「INTERNAL」，用户
 * 既不知道发生了什么，也不知道该去哪看。
 */
const INTERNAL_MESSAGE = '控制台内部错误，详见控制台日志';

/**
 * 把 handler 的异常收敛成 JSON 错误。
 *
 * 区分两类：`HttpError` 是**预期内**的（参数错、未登录），把 code 原样给前端；
 * 其它异常一律 500 + `INTERNAL`，message 用固定文案 —— 原始 message 不回传，
 * 但前端拿到的必须是**一句人话**，不是 code 本身。
 */
export async function guard(
  response: ServerResponse,
  handler: () => Promise<boolean> | boolean,
): Promise<boolean> {
  try {
    return await handler();
  } catch (cause) {
    if (cause instanceof HttpError) {
      respondJson(response, cause.status, {
        code: cause.code,
        ...(cause.message !== cause.code ? { message: cause.message } : {}),
      });
      return true;
    }
    respondJson(response, 500, { code: 'INTERNAL', message: INTERNAL_MESSAGE });
    return true;
  }
}

/** `GET` 才允许；否则 405。 */
export function requireMethod(request: IncomingMessage, ...methods: string[]): void {
  const method = request.method ?? 'GET';
  if (!methods.includes(method)) {
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', `只支持 ${methods.join(' / ')}`);
  }
}
