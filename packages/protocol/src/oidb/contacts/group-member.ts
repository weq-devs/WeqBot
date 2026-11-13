/**
 * 群成员全量拉取：在 WeQ 已有的 `0xfe7_3` spec（`oidb/group-admin/group-settings.ts`）
 * 之上加一层分页循环。
 *
 * 单页 spec 只负责一次往返；翻页游标是服务端下发的 `token`，空串即末页。
 * 调用方（OneBot 后端 / 名字服务）应自己做 TTL 缓存 —— 大群高频拉取会触发风控。
 */

import type { OidbNative } from '../../transport';
import { FetchGroupMemberListPage, type GroupMemberListItem } from '../group-admin/group-settings';

export interface FetchAllGroupMembersOptions {
  /** 最多翻多少页，防止服务端异常时死循环。默认 100。 */
  maxPages?: number;
}

/** 按 token 翻页直到末页，拼成全量成员列表。 */
export async function fetchAllGroupMembers(
  nt: OidbNative,
  sessionId: number,
  groupId: number,
  options: FetchAllGroupMembersOptions = {},
): Promise<GroupMemberListItem[]> {
  const maxPages = options.maxPages ?? 100;
  const members: GroupMemberListItem[] = [];
  let token = '';

  for (let page = 0; page < maxPages; page++) {
    const result = await FetchGroupMemberListPage.invoke(nt, sessionId, {
      groupId,
      ...(token ? { token } : {}),
    });
    members.push(...result.members);
    if (!result.token) break;
    token = result.token;
  }

  return members;
}
