/**
 * 服务端英译中：OIDB 0x990_2。
 *
 * 搬运自 SnowLuma `packages/protocol/src/oidb-services/misc/translate-en-to-zh.ts`
 * （2026-11-13），改为 WeqBot 的 `message()` schema 写法。
 *
 * 回包的 `dstWords` 与请求的 `words` **一一对应**（同下标即同一句）。`tag10` /
 * `tag12` 线上恒为 1，用途未知，照抄即可 —— 去掉可能被服务端拒。
 *
 * 签名：0x990_2 不在 WeQ 的 SIGN_RULES 里（SnowLuma 也未记录），**三端待实测**。
 */

import { message } from '../../protobuf';
import { invokeOidb, type OidbSpec } from '../invoke';
import type { OidbNative } from '../../transport';

const TRANSLATE_REQ_BODY = message([
  { name: 'srcLang', tag: 1, type: 'string' },
  { name: 'dstLang', tag: 2, type: 'string' },
  { name: 'words', tag: 3, type: 'string', repeated: true },
]);

const TRANSLATE_REQ = message([
  { name: 'translateReq', tag: 2, type: TRANSLATE_REQ_BODY },
  { name: 'tag10', tag: 10, type: 'uint32' },
  { name: 'tag12', tag: 12, type: 'uint32' },
]);

const TRANSLATE_RESP_BODY = message([
  { name: 'errorCode', tag: 1, type: 'uint32' },
  { name: 'errorMsg', tag: 2, type: 'string' },
  { name: 'srcLang', tag: 3, type: 'string' },
  { name: 'dstLang', tag: 4, type: 'string' },
  { name: 'srcWords', tag: 5, type: 'string', repeated: true },
  { name: 'dstWords', tag: 6, type: 'string', repeated: true },
]);

const TRANSLATE_RESP = message([{ name: 'translateResp', tag: 2, type: TRANSLATE_RESP_BODY }]);

export interface TranslateEnToZhParams {
  words: string[];
}

export namespace TranslateEnToZh {
  export const command = 0x990;
  export const subCommand = 2;

  export const reqSchema = TRANSLATE_REQ;
  export const respSchema = TRANSLATE_RESP;

  export function serialize(params: TranslateEnToZhParams): Record<string, unknown> {
    return {
      translateReq: { srcLang: 'en', dstLang: 'zh', words: params.words },
      tag10: 1,
      tag12: 1,
    };
  }

  export function deserialize(body: Record<string, unknown>): string[] {
    const resp = body.translateResp as Record<string, unknown> | undefined;
    if (!resp) throw new Error('0x990_2 翻译回包为空');
    return ((resp.dstWords as string[] | undefined) ?? []).filter(
      (word): word is string => typeof word === 'string',
    );
  }

  export function invoke(
    nt: OidbNative,
    sessionId: number,
    params: TranslateEnToZhParams,
  ): Promise<string[]> {
    return invokeOidb(
      nt,
      sessionId,
      TranslateEnToZh as OidbSpec<TranslateEnToZhParams, string[]>,
      params,
    );
  }
}
