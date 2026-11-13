/**
 * OIDB 0xfd4_1 —— 好友列表分页。
 *
 * 搬运自 SnowLuma `packages/protocol/src/oidb-services/contacts/fetch-friend-list-page.ts`
 * （2026-11-13），改为 WeqBot 的 `message()` schema 写法。
 *
 * 一次只取一页：服务端用不透明 cookie 分页，首页不传 cookie，直到回包不再给
 * cookie 为止。好友的昵称 / 备注 / 签名等都在 `additional[].layer1` 的
 * 属性表里（code → 值），用 {@link decodePublicProfile} 解。
 *
 * 签名：0xfd4_1 在 WeQ 的 SIGN_RULES 里是 `non-linux`（Linux 不签、Windows /
 * macOS 签），来自 WeQ 自己的探测记录；**三端待复核**。
 */

import { message } from '../../protobuf';
import { invokeOidb, type OidbSpec } from '../invoke';
import { toInt } from '../shared';
import type { OidbNative } from '../../transport';
import {
  decodePublicProfile,
  PUBLIC_PROFILE_KEYS,
  type PublicProfileFields,
} from './public-profile';

const FRIEND_NUMBER_PROPERTY = message([
  { name: 'key', tag: 1, type: 'uint32' },
  { name: 'value', tag: 2, type: 'int32' },
]);

const FRIEND_PROPERTY = message([
  { name: 'code', tag: 1, type: 'uint32' },
  { name: 'value', tag: 2, type: 'bytes' },
]);

const FRIEND_LAYER1 = message([
  { name: 'numberProperties', tag: 1, type: FRIEND_NUMBER_PROPERTY, repeated: true },
  { name: 'properties', tag: 2, type: FRIEND_PROPERTY, repeated: true },
]);

const FRIEND_ADDITIONAL = message([
  { name: 'type', tag: 1, type: 'uint32' },
  { name: 'layer1', tag: 2, type: FRIEND_LAYER1 },
]);

const FRIEND = message([
  { name: 'uid', tag: 1, type: 'string' },
  { name: 'customGroup', tag: 2, type: 'uint32' },
  { name: 'uin', tag: 3, type: 'uint32' },
  { name: 'additional', tag: 10001, type: FRIEND_ADDITIONAL, repeated: true },
]);

const FRIEND_CATEGORY = message([
  { name: 'categoryId', tag: 1, type: 'uint32' },
  { name: 'categoryName', tag: 2, type: 'string' },
  { name: 'memberCount', tag: 3, type: 'uint32' },
  { name: 'sortId', tag: 4, type: 'uint32' },
]);

const FRIEND_LIST_NUMBERS = message([{ name: 'numbers', tag: 1, type: 'uint32', repeated: true }]);

const FRIEND_LIST_BODY_ITEM = message([
  { name: 'type', tag: 1, type: 'uint32' },
  { name: 'number', tag: 2, type: FRIEND_LIST_NUMBERS },
]);

const FRIEND_LIST_REQ = message([
  { name: 'friendCount', tag: 2, type: 'uint32' },
  { name: 'field4', tag: 4, type: 'uint32' },
  { name: 'cookie', tag: 5, type: 'bytes' },
  { name: 'field6', tag: 6, type: 'uint32' },
  { name: 'field7', tag: 7, type: 'uint32' },
  { name: 'body', tag: 10001, type: FRIEND_LIST_BODY_ITEM, repeated: true },
  { name: 'field10002', tag: 10002, type: 'uint32', repeated: true },
  { name: 'field10003', tag: 10003, type: 'uint32' },
]);

const FRIEND_LIST_RESP = message([
  { name: 'cookie', tag: 2, type: 'bytes' },
  { name: 'isEnd', tag: 3, type: 'bool' },
  { name: 'timestamp', tag: 6, type: 'uint64' },
  { name: 'selfUin', tag: 7, type: 'uint64' },
  { name: 'smallSeq', tag: 8, type: 'uint32' },
  { name: 'friends', tag: 101, type: FRIEND, repeated: true },
  { name: 'categories', tag: 102, type: FRIEND_CATEGORY, repeated: true },
]);

export interface FriendListPageParams {
  /** 上一页返回的 cookie；首页不传。 */
  cookie?: Uint8Array;
}

export interface FriendInfo {
  uin: number;
  uid: string;
  nickname: string;
  remark: string;
  categoryId: number;
  profile?: PublicProfileFields;
}

export interface FriendCategory {
  categoryId: number;
  categoryName: string;
  memberCount: number;
  sortId: number;
}

export interface FriendListPage {
  friends: FriendListEntry[];
  categories: FriendCategory[];
  /** 为空 = 已到末页。 */
  cookie?: Uint8Array;
}

export type FriendListEntry = { friend: FriendInfo; categoryId: number };

/** 把一条好友的 `additional[type=1].layer1` 摊平成两张属性表。 */
function friendProperties(raw: Record<string, unknown>): {
  bytes: Map<number, Uint8Array>;
  numbers: Map<number, number>;
} {
  const bytes = new Map<number, Uint8Array>();
  const numbers = new Map<number, number>();
  for (const additional of (raw.additional as Record<string, unknown>[] | undefined) ?? []) {
    if (toInt(additional.type) !== 1) continue;
    const layer1 = additional.layer1 as Record<string, unknown> | undefined;
    if (!layer1) continue;
    for (const property of (layer1.properties as Record<string, unknown>[] | undefined) ?? []) {
      if (property.value instanceof Uint8Array) bytes.set(toInt(property.code), property.value);
    }
    for (const property of (layer1.numberProperties as Record<string, unknown>[] | undefined) ??
      []) {
      numbers.set(toInt(property.key), toInt(property.value));
    }
  }
  return { bytes, numbers };
}

function mapFriend(raw: Record<string, unknown>): FriendListEntry {
  const { bytes, numbers } = friendProperties(raw);
  const profile = decodePublicProfile(bytes, numbers);
  const uin = toInt(raw.uin);
  const nickname = bytes.has(20002)
    ? new TextDecoder('utf-8').decode(bytes.get(20002)!)
    : String(uin);
  const remark = bytes.has(103) ? new TextDecoder('utf-8').decode(bytes.get(103)!) : '';
  const categoryId = toInt(raw.customGroup);
  return {
    categoryId,
    friend: {
      uin,
      uid: typeof raw.uid === 'string' ? raw.uid : '',
      nickname,
      remark,
      categoryId,
      ...(Object.keys(profile).length > 0 ? { profile } : {}),
    },
  };
}

export namespace FetchFriendListPage {
  export const command = 0xfd4;
  export const subCommand = 1;

  export const reqSchema = FRIEND_LIST_REQ;
  export const respSchema = FRIEND_LIST_RESP;

  export function serialize(params: FriendListPageParams): Record<string, unknown> {
    return {
      friendCount: 300,
      field4: 0,
      field6: 1,
      field7: 0x7fffffff,
      body: [
        {
          type: 1,
          number: { numbers: [...new Set([103, 102, 20002, 27394, ...PUBLIC_PROFILE_KEYS])] },
        },
        { type: 4, number: { numbers: [100, 101, 102] } },
      ],
      field10002: [13578, 13579, 13573, 13572, 13568],
      field10003: 4051,
      ...(params.cookie?.length ? { cookie: params.cookie } : {}),
    };
  }

  export function deserialize(body: Record<string, unknown>): FriendListPage {
    const friends = ((body.friends as Record<string, unknown>[] | undefined) ?? []).map(mapFriend);
    const categories = ((body.categories as Record<string, unknown>[] | undefined) ?? []).map(
      (raw) => ({
        categoryId: toInt(raw.categoryId),
        categoryName: typeof raw.categoryName === 'string' ? raw.categoryName : '',
        memberCount: toInt(raw.memberCount),
        sortId: toInt(raw.sortId),
      }),
    );
    const cookie = body.cookie instanceof Uint8Array ? body.cookie : undefined;
    return { friends, categories, ...(cookie?.length ? { cookie } : {}) };
  }

  export function invoke(
    nt: OidbNative,
    sessionId: number,
    params: FriendListPageParams,
  ): Promise<FriendListPage> {
    return invokeOidb(
      nt,
      sessionId,
      FetchFriendListPage as OidbSpec<FriendListPageParams, FriendListPage>,
      params,
    );
  }
}

/** 拉全量好友：按 cookie 循环，直到服务端不再给 cookie。 */
export async function fetchAllFriends(
  nt: OidbNative,
  sessionId: number,
  options: { maxPages?: number } = {},
): Promise<{ friends: FriendListEntry[]; categories: FriendCategory[] }> {
  const friends: FriendListEntry[] = [];
  const categories: FriendCategory[] = [];
  let cookie: Uint8Array | undefined;
  const maxPages = options.maxPages ?? 100;

  for (let page = 0; page < maxPages; page++) {
    const result = await FetchFriendListPage.invoke(nt, sessionId, cookie ? { cookie } : {});
    friends.push(...result.friends);
    if (page === 0) categories.push(...result.categories);
    if (!result.cookie || result.cookie.length === 0) break;
    cookie = result.cookie;
  }

  return { friends, categories };
}
