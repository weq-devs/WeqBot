/**
 * OneBot `message` 参数 → segment 数组。
 *
 * 接受三种形态（与 OneBot v11 一致）：
 *   - string：CQ 码串（`auto_escape=true` 时整段当纯文本）；
 *   - array：`{ type, data }[]`；
 *   - object：单个 segment，包成数组。
 *
 * 搬运自 SnowLuma `packages/onebot/src/message-parser.ts`（2026-11-13），
 * 去掉它那套输入糖（音乐/位置/联系人卡片等）—— 那些需要协议侧对应的发送
 * 构造，等 WeqBot 有了再接。
 */

import { parseCQString } from './cq';
import type { Segment } from './segments';

const MAX_SEGMENTS = 256;

function isSegment(value: unknown): value is { type: string; data?: Record<string, unknown> } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

/** shape 归一：补上 `data`，不改类型。真正的元素构造在 `segments.ts`。 */
function normalizeSegment(segment: { type: string; data?: Record<string, unknown> }): Segment {
  return { type: segment.type, data: segment.data ?? {} };
}

/**
 * 把 `message` 参数解析成出站元素数组。
 *
 * 返回的是 **OneBot segment 形状**（`{ type, data }`）：CQ 串与数组两条路径
 * 共用同一份校验。要发给协议层时再走 `segments.ts` 的 `segmentsToElements`。
 */
export function parseMessageSegments(message: unknown, autoEscape = false): Segment[] {
  let segments: { type: string; data?: Record<string, unknown> }[];

  if (typeof message === 'string') {
    if (autoEscape) {
      segments = [{ type: 'text', data: { text: message } }];
    } else {
      segments = parseCQString(message);
    }
  } else if (Array.isArray(message)) {
    if (!message.every(isSegment)) throw new Error('message 数组里有非法 segment');
    segments = message;
  } else if (isSegment(message)) {
    segments = [message];
  } else {
    throw new Error('message 必须是字符串、segment 数组或单个 segment');
  }

  if (segments.length === 0) return [];
  if (segments.length > MAX_SEGMENTS) throw new Error(`message 段数超过上限 ${MAX_SEGMENTS}`);

  return segments.map(normalizeSegment);
}
