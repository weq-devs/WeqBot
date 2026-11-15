// OIDB 0x9060_3 — 群分享 / 邀请链接（SnowLuma GetGroupShareLink）。
//
// 请求：f1 type=2，f12 group{groupCode, additionalParam, needShortUrl}
// 响应：f12 group.url

import { message } from '../../protobuf';
import { invokeOidb, type OidbSpec } from '../invoke';
import type { OidbNative } from '../../transport';

const GROUP_SHARE_LINK_GROUP = message([
  { name: 'groupCode', tag: 1, type: 'uint64' },
  { name: 'additionalParam', tag: 3, type: 'string' },
  { name: 'needShortUrl', tag: 4, type: 'bool' },
]);

const GROUP_SHARE_LINK_REQ = message([
  { name: 'type', tag: 1, type: 'uint64' },
  { name: 'group', tag: 12, type: GROUP_SHARE_LINK_GROUP },
]);

const GROUP_SHARE_LINK_RESP_GROUP = message([{ name: 'url', tag: 1, type: 'string' }]);

const GROUP_SHARE_LINK_RESP = message([
  { name: 'group', tag: 12, type: GROUP_SHARE_LINK_RESP_GROUP },
]);

export interface GroupShareLinkParams {
  groupId: number;
  needShortUrl: boolean;
  additionalParam: string;
}

export namespace GetGroupShareLink {
  export const command = 0x9060;
  export const subCommand = 3;
  export const reqSchema = GROUP_SHARE_LINK_REQ;
  export const respSchema = GROUP_SHARE_LINK_RESP;

  export const serialize = (p: GroupShareLinkParams): Record<string, unknown> => ({
    type: 2n,
    group: {
      groupCode: BigInt(p.groupId),
      additionalParam: p.additionalParam,
      needShortUrl: p.needShortUrl,
    },
  });

  export const deserialize = (body: Record<string, unknown>): string => {
    const group = body.group as Record<string, unknown> | undefined;
    const url = typeof group?.url === 'string' ? group.url.trim() : '';
    if (!url) throw new Error('群分享链接响应没有 URL');
    return url;
  };

  export const invoke = (
    nt: OidbNative,
    pid: number,
    params: GroupShareLinkParams,
  ): Promise<string> =>
    invokeOidb(nt, pid, GetGroupShareLink as OidbSpec<GroupShareLinkParams, string>, params);
}
