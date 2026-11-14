/**
 * 入站媒体的下载 URL 解析。
 *
 * 推送里的 `pic` / `ptt` / `video` 元素只有 `fileToken`（服务端文件 ID），
 * 真正能下载还要一份 **rkey** —— 由 `FetchDownloadRkeys`（OIDB `0x9067_202`）
 * 按「场景 × 媒体种类」签发。rkey 有 TTL，所以这里带缓存。
 *
 * URL 形状与 WeQ 的 `packages/service/src/account/media_download.ts` 一致：
 *
 *   https://multimedia.nt.qq.com.cn/download?appid=<1406|1407>&fileid=<token>&spec=0&rkey=…
 *
 * 群场景 appid 用 1407、私聊 1406（由 rkey 的 `type` 反推：20/22/24 是群）。
 *
 * 这里**只拼 URL，不下载**。真正的取字节由 OneBot 客户端或宿主决定。
 */

import type { OidbSpec, ProtocolClient } from '@weqbot/protocol';
import { FetchDownloadRkeys, type DownloadRkey } from '@weqbot/protocol';
import type { Logger } from '@weqbot/common';

const MEDIA_HOST = 'https://multimedia.nt.qq.com.cn';
const DOWNLOAD_BASE = `${MEDIA_HOST}/download`;

/** rkey 类型（与协议注释同源）：私聊/群 × 图片/视频/语音，`2` 是兜底。 */
const RKEY_TYPE = {
  privateImage: 10,
  groupImage: 20,
  fallback: 2,
  privateVideo: 12,
  groupVideo: 22,
  privatePtt: 14,
  groupPtt: 24,
} as const;

const GROUP_TYPES = new Set<number>([
  RKEY_TYPE.groupImage,
  RKEY_TYPE.groupVideo,
  RKEY_TYPE.groupPtt,
]);

export interface MediaUrlResolverOptions {
  protocol: ProtocolClient;
  logger?: Logger;
  /** 提前多久视为过期，默认 60s（留出网络与客户端下载的时间）。 */
  expirySkewSeconds?: number;
}

export interface MediaUrlResolver {
  /** 图片 / 表情（`pic`）。拿不到 rkey 时返回空串。 */
  imageUrl(element: Record<string, unknown>, isGroup: boolean): Promise<string>;
  /** 语音 / 视频（`ptt` / `video`）。拿不到 rkey 时返回空串。 */
  mediaUrl(element: Record<string, unknown>, isGroup: boolean): Promise<string>;
}

/**
 * 建一个带缓存的解析器。
 *
 * 所有失败路径都返回空串而不是抛错：URL 缺失只让 `url` 字段为空，不应该让整条
 * 消息事件丢掉。
 */
export function createMediaUrlResolver(options: MediaUrlResolverOptions): MediaUrlResolver {
  const { protocol } = options;
  const skew = options.expirySkewSeconds ?? 60;
  /** rkey 列表按「种类」缓存；`expiresAt` 是这批 rkey 里最早过期的那个。 */
  let cached: { types: string; entries: DownloadRkey[]; expiresAt: number } | undefined;

  async function rkeysFor(types: number[]): Promise<DownloadRkey[]> {
    const key = [...types].sort((a, b) => a - b).join(',');
    const now = Math.floor(Date.now() / 1000);
    if (cached && cached.types === key && cached.expiresAt > now) return cached.entries;

    try {
      // 走门面的 `oidb()` 而不是直接调 `invoke(native, sessionId, …)`：
      // 少传两遍句柄，单测里也能只桩一处。
      const entries = await protocol.oidb(
        FetchDownloadRkeys as OidbSpec<FetchDownloadRkeys.Params, DownloadRkey[]>,
        { types },
      );
      const expiresAt = entries.length
        ? Math.min(...entries.map((entry) => entry.createTime + entry.ttlSeconds)) - skew
        : 0;
      cached = { types: key, entries, expiresAt };
      return entries;
    } catch (cause) {
      options.logger?.debug('取下载 rkey 失败，媒体 URL 留空', { types, cause });
      return [];
    }
  }

  function pick(entries: DownloadRkey[], preferred: number): DownloadRkey | undefined {
    return entries.find((entry) => entry.type === preferred) ?? entries[0];
  }

  function compose(fileToken: string, rkey: DownloadRkey): string {
    const appid = GROUP_TYPES.has(rkey.type) ? '1407' : '1406';
    // QQ 返回的 rkey 通常自带 `&rkey=` 前缀；没带时补上，避免拼出坏 URL。
    const suffix = rkey.rkey.startsWith('&')
      ? rkey.rkey
      : rkey.rkey.startsWith('rkey=')
        ? `&${rkey.rkey}`
        : `&rkey=${rkey.rkey}`;
    return `${DOWNLOAD_BASE}?appid=${appid}&fileid=${encodeURIComponent(fileToken)}&spec=0${suffix}`;
  }

  async function resolve(
    element: Record<string, unknown>,
    isGroup: boolean,
    privateType: number,
    groupType: number,
  ): Promise<string> {
    const fileToken = typeof element.fileToken === 'string' ? element.fileToken : '';
    if (!fileToken) return '';
    // 服务端会给「私聊 + 群 + 兜底」三种 rkey；语音/视频得显式要，一次要齐更好。
    const types = isGroup ? [groupType, RKEY_TYPE.fallback] : [privateType, RKEY_TYPE.fallback];
    const entries = await rkeysFor(types);
    const rkey = pick(entries, isGroup ? groupType : privateType);
    return rkey ? compose(fileToken, rkey) : '';
  }

  return {
    imageUrl: (element, isGroup) =>
      resolve(element, isGroup, RKEY_TYPE.privateImage, RKEY_TYPE.groupImage),
    mediaUrl: async (element, isGroup) => {
      // 三种媒体共用一份 rkey 表：先按元素种类选 type，再退回图片那套。
      if (element.kind === 'ptt') {
        return resolve(element, isGroup, RKEY_TYPE.privatePtt, RKEY_TYPE.groupPtt);
      }
      if (element.kind === 'video') {
        return resolve(element, isGroup, RKEY_TYPE.privateVideo, RKEY_TYPE.groupVideo);
      }
      // 群文件走 OIDB 0x6D6 的 `get-file-url`，不在 rkey 体系里。
      return '';
    },
  };
}
