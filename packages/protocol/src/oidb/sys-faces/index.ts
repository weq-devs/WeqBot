/**
 * 系统表情 / 表情包目录：OIDB 0x9154_1（全量目录）与 0x9155_1（单个）。
 *
 * 搬运自 SnowLuma `packages/protocol/src/oidb-services/sys-faces/*`（2026-11-13），
 * 改为 WeqBot 的 `message()` schema 写法。
 *
 * 用途：发送动态 / 超级表情时需要目录里的 `aniSticker*` 元数据来选择编码
 * （见 `msg/send-elements.ts` 的 `SendSuperSticker`）；`qSid` 是 QQ 的目录
 * 标识，普通小黄脸是十进制数字串，emoji 组可能是 Unicode 字符。
 *
 * 签名：这两条不在 WeQ 的 SIGN_RULES 里（SnowLuma 也未记录），**三端待实测**。
 */

import { message } from '../../protobuf';
import { invokeOidb, type OidbSpec } from '../invoke';
import { toInt } from '../shared';
import type { OidbNative } from '../../transport';

const FACE_RESOURCE_URL = message([
  { name: 'baseUrl', tag: 1, type: 'string' },
  { name: 'advUrl', tag: 2, type: 'string' },
]);

const FACE_EMOJI = message([
  { name: 'qSid', tag: 1, type: 'string' },
  { name: 'qDes', tag: 2, type: 'string' },
  { name: 'emCode', tag: 3, type: 'string' },
  { name: 'qCid', tag: 4, type: 'int32' },
  { name: 'aniStickerType', tag: 5, type: 'int32' },
  { name: 'aniStickerPackId', tag: 6, type: 'int32' },
  { name: 'aniStickerId', tag: 7, type: 'int32' },
  { name: 'url', tag: 8, type: FACE_RESOURCE_URL },
  { name: 'emojiNameAlias', tag: 9, type: 'string', repeated: true },
  { name: 'unknown10', tag: 10, type: 'int32' },
  { name: 'aniStickerWidth', tag: 13, type: 'int32' },
  { name: 'aniStickerHeight', tag: 14, type: 'int32' },
]);

const FACE_EMOJI_LIST = message([
  { name: 'emojiPackName', tag: 1, type: 'string' },
  { name: 'emojiDetail', tag: 2, type: FACE_EMOJI, repeated: true },
]);

const FACE_CONTENT = message([
  { name: 'emojiList', tag: 1, type: FACE_EMOJI_LIST, repeated: true },
  { name: 'resourceUrl', tag: 2, type: FACE_RESOURCE_URL },
]);

const SYS_FACES_RESP = message([
  { name: 'field1', tag: 1, type: 'int32' },
  { name: 'commonFace', tag: 2, type: FACE_CONTENT },
  { name: 'specialBigFace', tag: 3, type: FACE_CONTENT },
  { name: 'specialMagicFace', tag: 4, type: FACE_CONTENT },
]);

const SYS_FACES_EXP_INFO = message([{ name: 'field1', tag: 1, type: 'string' }]);

const SYS_FACES_REQ = message([
  { name: 'field1', tag: 1, type: 'int32' },
  { name: 'field2', tag: 2, type: 'int32' },
  { name: 'field3', tag: 3, type: 'int32' },
  { name: 'field4', tag: 4, type: SYS_FACES_EXP_INFO },
]);

const SYS_FACE_REQ = message([{ name: 'qSid', tag: 1, type: 'string' }]);

const SYS_FACE_RESP = message([
  { name: 'emoji', tag: 1, type: FACE_EMOJI },
  { name: 'field2', tag: 2, type: 'bool' },
]);

export interface SysFaceEntry {
  /** QQ 目录标识：普通小黄脸是十进制串，emoji 组可能是 Unicode。 */
  qSid: string;
  qDes: string;
  emCode: string;
  qCid: number | null;
  aniStickerType: number | null;
  aniStickerPackId: number | null;
  aniStickerId: number | null;
  url: string | null;
  emojiNameAlias: string[];
  aniStickerWidth: number | null;
  aniStickerHeight: number | null;
}

export interface SysFacePackEntry {
  packName: string;
  emojis: SysFaceEntry[];
}

function emojiToEntry(raw: Record<string, unknown>): SysFaceEntry | null {
  const qSid = raw.qSid;
  // 没有 id 的条目无法发送，直接跳过（不要抛错，目录里确实有占位项）。
  if (typeof qSid !== 'string' || qSid === '') return null;
  const url = (raw.url as Record<string, unknown> | undefined) ?? {};
  return {
    qSid,
    qDes: typeof raw.qDes === 'string' ? raw.qDes : '',
    emCode: typeof raw.emCode === 'string' ? raw.emCode : '',
    qCid: raw.qCid === undefined ? null : toInt(raw.qCid),
    aniStickerType: raw.aniStickerType === undefined ? null : toInt(raw.aniStickerType),
    aniStickerPackId: raw.aniStickerPackId === undefined ? null : toInt(raw.aniStickerPackId),
    aniStickerId: raw.aniStickerId === undefined ? null : toInt(raw.aniStickerId),
    url: typeof url.baseUrl === 'string' ? url.baseUrl : null,
    emojiNameAlias: ((raw.emojiNameAlias as string[] | undefined) ?? []).filter(
      (alias): alias is string => typeof alias === 'string',
    ),
    aniStickerWidth: raw.aniStickerWidth === undefined ? null : toInt(raw.aniStickerWidth),
    aniStickerHeight: raw.aniStickerHeight === undefined ? null : toInt(raw.aniStickerHeight),
  };
}

export namespace FetchSysFaces {
  export const command = 0x9154;
  export const subCommand = 1;

  export const reqSchema = SYS_FACES_REQ;
  export const respSchema = SYS_FACES_RESP;

  export function serialize(): Record<string, unknown> {
    return { field1: 0, field2: 7, field3: 0 };
  }

  export function deserialize(body: Record<string, unknown>): SysFacePackEntry[] {
    const packs: SysFacePackEntry[] = [];
    // 三个面板（普通 / 大表情 / 魔法表情）都是 repeated 分组，含匿名/隐藏分组。
    for (const [source, content] of [
      ['common', body.commonFace],
      ['special-big', body.specialBigFace],
      ['magic', body.specialMagicFace],
    ] as const) {
      const lists =
        ((content as Record<string, unknown> | undefined)?.emojiList as
          | Record<string, unknown>[]
          | undefined) ?? [];
      for (const list of lists) {
        packs.push({
          packName:
            typeof list.emojiPackName === 'string' && list.emojiPackName
              ? list.emojiPackName
              : source === 'magic'
                ? 'MagicFace'
                : '',
          emojis: ((list.emojiDetail as Record<string, unknown>[] | undefined) ?? [])
            .map(emojiToEntry)
            .filter((entry): entry is SysFaceEntry => entry !== null),
        });
      }
    }
    return packs;
  }

  export function invoke(nt: OidbNative, sessionId: number): Promise<SysFacePackEntry[]> {
    return invokeOidb(
      nt,
      sessionId,
      FetchSysFaces as unknown as OidbSpec<Record<string, never>, SysFacePackEntry[]>,
      {},
    );
  }
}

export namespace FetchSysFace {
  export const command = 0x9155;
  export const subCommand = 1;

  export const reqSchema = SYS_FACE_REQ;
  export const respSchema = SYS_FACE_RESP;

  export interface Params {
    faceId: number;
  }

  export function serialize(params: Params): Record<string, unknown> {
    return { qSid: String(params.faceId) };
  }

  export function deserialize(body: Record<string, unknown>): SysFaceEntry | null {
    const emoji = body.emoji as Record<string, unknown> | undefined;
    if (!emoji) return null;
    const entry = emojiToEntry(emoji);
    if (!entry) throw new Error('系统表情查询回包缺少 id');
    return entry;
  }

  export function invoke(
    nt: OidbNative,
    sessionId: number,
    params: Params,
  ): Promise<SysFaceEntry | null> {
    return invokeOidb(nt, sessionId, FetchSysFace as OidbSpec<Params, SysFaceEntry | null>, params);
  }
}

/** 在目录里按数字 faceId 找条目。 */
export function findFaceEntity(packs: SysFacePackEntry[], faceId: number): SysFaceEntry | null {
  const idStr = String(faceId);
  for (const pack of packs) {
    for (const emoji of pack.emojis) {
      if (emoji.qSid === idStr) return emoji;
    }
  }
  return null;
}

/** 目录是否声明了动态表情表示。 */
export function isSuperFaceEntry(emoji: SysFaceEntry): boolean {
  return emoji.aniStickerType != null && emoji.aniStickerType > 0;
}

export function isSuperFaceId(packs: SysFacePackEntry[], faceId: number): boolean {
  const emoji = findFaceEntity(packs, faceId);
  return emoji !== null && isSuperFaceEntry(emoji);
}
