/**
 * NDJSON 分帧。
 *
 * 必须处理半行：stdio 的 `data` 事件不保证按行边界到达（大事件、PID 调度都会切开）。
 * 所以解码器是有状态的 —— 用 `ControlLineDecoder`，不要自己 `split('\n')`。
 */

import { WeqBotError } from '@weqbot/common';
import { CONTROL_PROTOCOL_VERSION, type ControlEnvelope, type ControlFailure } from './protocol';

/** 单行上限。推送帧本身就可能有几百 KB（合并转发），但 8 MiB 已经远高于正常值。 */
export const MAX_CONTROL_LINE_BYTES = 8 * 1024 * 1024;

const utf8 = new TextDecoder();
const NEWLINE = 0x0a;

export function encodeEnvelope(envelope: ControlEnvelope): string {
  return `${JSON.stringify(envelope)}\n`;
}

/** 解析并校验一行。校验失败一律抛 `CONTROL_PROTOCOL_ERROR`，不做「尽量容忍」。 */
export function decodeEnvelope(line: string): ControlEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (cause) {
    throw new WeqBotError('CONTROL_PROTOCOL_ERROR', '控制通道收到非 JSON 行', { cause });
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw invalid('信封必须是对象');
  }

  const envelope = parsed as Record<string, unknown>;

  if (envelope['v'] !== CONTROL_PROTOCOL_VERSION) {
    throw invalid(`协议版本不符：期望 ${CONTROL_PROTOCOL_VERSION}，收到 ${String(envelope['v'])}`);
  }

  switch (envelope['kind']) {
    case 'request': {
      if (!isId(envelope['id'])) throw invalid('request 缺少整数 id');
      if (typeof envelope['method'] !== 'string' || envelope['method'] === '') {
        throw invalid('request 缺少 method');
      }
      return envelope as unknown as ControlEnvelope;
    }
    case 'response': {
      if (!isId(envelope['id'])) throw invalid('response 缺少整数 id');
      if (typeof envelope['ok'] !== 'boolean') throw invalid('response 缺少布尔 ok');
      if (!envelope['ok'] && !isFailure(envelope['error']))
        throw invalid('失败的 response 缺少 error');
      return envelope as unknown as ControlEnvelope;
    }
    case 'event': {
      if (typeof envelope['event'] !== 'string' || envelope['event'] === '') {
        throw invalid('event 缺少 event 名');
      }
      return envelope as unknown as ControlEnvelope;
    }
    default:
      throw invalid(`未知 kind：${String(envelope['kind'])}`);
  }
}

/** 有状态的按行解码器：喂 chunk（可能是半行），吐完整的信封。 */
export class ControlLineDecoder {
  #pending = new Uint8Array(0);

  push(chunk: Uint8Array): ControlEnvelope[] {
    const data = new Uint8Array(this.#pending.length + chunk.length);
    data.set(this.#pending, 0);
    data.set(chunk, this.#pending.length);

    const envelopes: ControlEnvelope[] = [];
    let start = 0;

    for (let i = 0; i < data.length; i += 1) {
      if (data[i] !== NEWLINE) continue;
      const line = utf8.decode(data.subarray(start, i)).trim();
      start = i + 1;
      if (line !== '') envelopes.push(decodeEnvelope(line));
    }

    // 不要让 pending 一直持有大的底层 buffer（slice 会复制）。
    this.#pending = data.slice(start);

    if (this.#pending.length > MAX_CONTROL_LINE_BYTES) {
      throw invalid(`单行超过 ${MAX_CONTROL_LINE_BYTES} 字节，可能缺少换行或通道被污染`);
    }

    return envelopes;
  }
}

function isId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isFailure(value: unknown): value is ControlFailure {
  if (typeof value !== 'object' || value === null) return false;
  const failure = value as Record<string, unknown>;
  return typeof failure['code'] === 'string' && typeof failure['message'] === 'string';
}

function invalid(message: string): WeqBotError {
  return new WeqBotError('CONTROL_PROTOCOL_ERROR', message);
}
