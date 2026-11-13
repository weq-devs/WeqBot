/**
 * 网络层公共部分：鉴权、角色、上限常量。
 *
 * 用 `ws`（纯 JS）而不是 SnowLuma 的自研 native addon —— 后者与 WeqBot
 * 「除 node 包外不加载原生组件」的护栏冲突。设计要点借 SnowLuma
 * `packages/onebot/src/network/`：role 决定能收什么、token 两种传法、慢客户端有界。
 */

import type { WsRole } from '../types';

export interface AuthorizationInput {
  header?: string | undefined;
  query?: string | undefined;
}

/** 鉴权：token 为空表示不鉴权。接受 `Bearer <token>` 与 `?access_token=`。 */
export function isAuthorized(
  token: string | undefined,
  input: AuthorizationInput,
  allowRawToken = false,
): boolean {
  const expected = token?.trim();
  if (!expected) return true;

  const header = input.header?.trim();
  if (header) {
    const bearer = /^Bearer\s+(.+)$/i.exec(header);
    if (bearer && bearer[1]?.trim() === expected) return true;
    if (allowRawToken && header === expected) return true;
  }
  return input.query?.trim() === expected;
}

/** `Api` 只收 action，`Event` 只收事件，`Universal` 两者都收。 */
export function canReceiveAction(role: WsRole): boolean {
  return role === 'Api' || role === 'Universal';
}

export function canReceiveEvent(role: WsRole): boolean {
  return role === 'Event' || role === 'Universal';
}

/** 单帧上限默认 100 MiB：够放整段无损语音，比它大的应改用 URL。 */
export const DEFAULT_MAX_PAYLOAD_BYTES = 100 * 1024 * 1024;

/** 慢客户端缓冲上限：超过就断开，而不是无限排队吃内存。 */
export const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

/** 关闭码：鉴权/路径不合法 1008，服务端下线 1012。 */
export const CLOSE_POLICY_VIOLATION = 1008;
export const CLOSE_SERVICE_RESTART = 1012;
