/**
 * CQ 码：OneBot 的字符串消息格式。
 *
 * 搬运自 SnowLuma `packages/onebot/src/helper/cq.ts`（2026-11-13）。只保留
 * 编解码与转义两层：把 segment 数组拼成 CQ 串、把 CQ 串拆回 segment 数组。
 * 具体 segment → 协议元素的映射在 `segments.ts`。
 *
 * 转义顺序不可改：`&amp;` 必须**最后**解，否则 `&amp;#91;` 会被解两次成 `[`。
 */

import type { JsonArray, JsonObject } from './types';

export const CQ_REGEX = /\[CQ:([A-Za-z][A-Za-z0-9_]*)(?:,([^\]]*))?\]/g;

export function parseCQParams(raw: string): Record<string, string> {
  const params: Record<string, string> = {};
  if (!raw) return params;
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=');
    if (eq > 0) params[pair.substring(0, eq)] = cqUnescape(pair.substring(eq + 1));
  }
  return params;
}

export function cqEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/\[/g, '&#91;')
    .replace(/\]/g, '&#93;')
    .replace(/,/g, '&#44;');
}

export function cqUnescape(text: string): string {
  // 顺序重要：`&amp;` 必须最后解，见文件头。
  return text
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&#44;/g, ',')
    .replace(/&amp;/g, '&');
}

/** 单个 segment → CQ 串。未识别的类型保留 `[CQ:type]` 占位。 */
export function segmentToCQ(segment: JsonObject): string {
  const type = String(segment.type ?? '');
  const data = (segment.data ?? {}) as Record<string, unknown>;

  switch (type) {
    case 'text':
      return cqEscape(String(data.text ?? ''));
    case 'face':
      return `[CQ:face,id=${data.id ?? 0}${
        data.resultId !== undefined ? `,resultId=${cqEscape(String(data.resultId))}` : ''
      }]`;
    case 'image':
      return `[CQ:image,file=${cqEscape(String(data.file ?? ''))},url=${cqEscape(
        String(data.url ?? ''),
      )}]`;
    case 'at':
      return `[CQ:at,qq=${data.qq ?? ''}]`;
    case 'reply':
      return `[CQ:reply,id=${data.id ?? 0}]`;
    case 'record':
      return `[CQ:record,file=${cqEscape(String(data.file ?? ''))},url=${cqEscape(
        String(data.url ?? ''),
      )}]`;
    case 'video':
      return `[CQ:video,file=${cqEscape(String(data.file ?? ''))},url=${cqEscape(
        String(data.url ?? ''),
      )}]`;
    case 'json':
      return `[CQ:json,data=${cqEscape(String(data.data ?? ''))}]`;
    case 'xml':
      return `[CQ:xml,data=${cqEscape(String(data.data ?? ''))}]`;
    case 'forward':
      return `[CQ:forward,id=${cqEscape(String(data.id ?? ''))}]`;
    case 'mface':
      return `[CQ:mface,name=${cqEscape(String(data.name ?? ''))}]`;
    case 'poke':
      return `[CQ:poke,type=${data.type ?? 0}]`;
    case 'file':
      return `[CQ:file,name=${cqEscape(String(data.name ?? ''))},size=${data.size ?? 0},id=${cqEscape(
        String(data.id ?? ''),
      )},url=${cqEscape(String(data.url ?? ''))}]`;
    default:
      return `[CQ:${type}]`;
  }
}

export function segmentsToRawMessage(segments: JsonArray): string {
  return segments.map((segment) => segmentToCQ(segment as JsonObject)).join('');
}

export interface ParsedCQSegment {
  type: string;
  data: Record<string, string>;
}

/** CQ 串 → `{ type, data }[]`（不做元素构造）。 */
export function parseCQString(message: string): ParsedCQSegment[] {
  const segments: ParsedCQSegment[] = [];
  let lastIndex = 0;

  for (const match of message.matchAll(CQ_REGEX)) {
    if (match.index! > lastIndex) {
      const text = cqUnescape(message.substring(lastIndex, match.index!));
      if (text) segments.push({ type: 'text', data: { text } });
    }
    lastIndex = match.index! + match[0].length;
    segments.push({ type: match[1]!, data: parseCQParams(match[2] ?? '') });
  }

  if (lastIndex < message.length) {
    const text = cqUnescape(message.substring(lastIndex));
    if (text) segments.push({ type: 'text', data: { text } });
  }

  return segments;
}
