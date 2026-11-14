/**
 * OIDB 0x929d_0 —— AI 声聊（TTS）声线目录。
 *
 * 搬运自 SnowLuma `packages/protocol/src/oidb-services/extras/fetch-ai-voice-list.ts`
 * （2026-11-15），改成 WeqBot 的 `message()` 写法。响应按服务端分组原样返回
 * （推荐 / 搞怪 / 古风 / 现代），同一条声线可能出现在多个分组，不去重。
 *
 * 0x929b 只负责合成；目录必须单独走这条命令，不能拿 voiceId 硬拼试听 URL
 * （样音文件名不保证等于 voiceId）。
 *
 * **签名**：SnowLuma 没有给出三端实测结论，先进 `UNCONFIRMED_SIGN_COMMANDS`。
 */

import { message } from '../../protobuf';
import type { OidbNative } from '../../transport';
import { invokeOidb, type OidbSpec } from '../invoke';

const AI_VOICE_LIST_REQ = message([
  { name: 'groupUin', tag: 1, type: 'uint32' },
  { name: 'chatType', tag: 2, type: 'uint32' },
]);

const AI_VOICE_ITEM = message([
  { name: 'voiceId', tag: 1, type: 'string' },
  { name: 'voiceDisplayName', tag: 2, type: 'string' },
  { name: 'voiceExampleUrl', tag: 3, type: 'string' },
]);

const AI_VOICE_CATEGORY = message([
  { name: 'category', tag: 1, type: 'string' },
  { name: 'voices', tag: 2, type: AI_VOICE_ITEM, repeated: true },
]);

const AI_VOICE_LIST_RESP = message([
  { name: 'content', tag: 1, type: AI_VOICE_CATEGORY, repeated: true },
]);

export interface AiVoiceItem {
  voiceId: string;
  voiceDisplayName: string;
  voiceExampleUrl: string;
}

export interface AiVoiceCategory {
  category: string;
  voices: AiVoiceItem[];
}

export namespace FetchAiVoiceList {
  export const command = 0x929d;
  export const subCommand = 0;

  export interface Params {
    /** 目标群号；目录按群维度下发。 */
    groupId: number;
    /** 1 = 群聊。 */
    chatType: number;
  }

  export const reqSchema = AI_VOICE_LIST_REQ;
  export const respSchema = AI_VOICE_LIST_RESP;

  export const serialize = (p: Params): Record<string, unknown> => {
    if (!Number.isSafeInteger(p.groupId) || p.groupId <= 0) {
      throw new Error('groupId 必须是正整数');
    }
    return { groupUin: p.groupId, chatType: p.chatType };
  };

  export const deserialize = (body: Record<string, unknown>): AiVoiceCategory[] =>
    ((body.content as Record<string, unknown>[] | undefined) ?? []).map((category) => ({
      category: typeof category.category === 'string' ? category.category : '',
      voices: ((category.voices as Record<string, unknown>[] | undefined) ?? []).map((item) => ({
        voiceId: typeof item.voiceId === 'string' ? item.voiceId : '',
        voiceDisplayName: typeof item.voiceDisplayName === 'string' ? item.voiceDisplayName : '',
        voiceExampleUrl: typeof item.voiceExampleUrl === 'string' ? item.voiceExampleUrl : '',
      })),
    }));

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<AiVoiceCategory[]> =>
    invokeOidb(nt, pid, FetchAiVoiceList as OidbSpec<Params, AiVoiceCategory[]>, params);
}
