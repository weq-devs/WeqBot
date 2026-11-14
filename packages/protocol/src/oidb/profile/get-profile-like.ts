// 0x7ED_12 — fetch QQ "thumbs up" (赞) summary for a user.
//
// Keyed by uid, not uin — callers resolve the uid first (the login probe
// carries it for the logged-in account).

import { message } from '../../protobuf';
import { toInt } from '../shared';
import { invokeOidb, type OidbSpec } from '../invoke';
import type { OidbNative } from '../../transport';

const LIKE_REQ = message([
  { name: 'targetUid', tag: 1, type: 'string' },
  { name: 'basic', tag: 2, type: 'uint32' },
  { name: 'vote', tag: 3, type: 'uint32' },
  { name: 'favorite', tag: 4, type: 'uint32' },
  { name: 'start', tag: 12, type: 'uint32' },
  { name: 'userProfile', tag: 101, type: 'uint32' },
  { name: 'limit', tag: 103, type: 'uint32' },
]);

/** 点赞 / 收藏明细里的一个用户。 */
const LIKE_USER = message([
  { name: 'uid', tag: 1, type: 'string' },
  { name: 'src', tag: 2, type: 'uint32' },
  { name: 'latestTime', tag: 3, type: 'uint32' },
  { name: 'count', tag: 4, type: 'uint32' },
  { name: 'giftCount', tag: 5, type: 'uint32' },
  { name: 'customId', tag: 6, type: 'uint32' },
  { name: 'lastCharged', tag: 8, type: 'uint32' },
  { name: 'availableCount', tag: 21, type: 'uint32' },
  { name: 'todayVotedCount', tag: 22, type: 'uint32' },
  { name: 'nick', tag: 101, type: 'string' },
  { name: 'gender', tag: 102, type: 'uint32' },
  { name: 'age', tag: 103, type: 'uint32' },
  { name: 'isFriend', tag: 104, type: 'bool' },
  { name: 'isVip', tag: 105, type: 'bool' },
  { name: 'isSvip', tag: 106, type: 'bool' },
]);

/** 收藏统计（用户列表在 tag 4）。 */
const FAVORITE_INFO = message([
  { name: 'totalCount', tag: 1, type: 'uint32' },
  { name: 'lastTime', tag: 2, type: 'uint32' },
  { name: 'todayCount', tag: 3, type: 'uint32' },
  { name: 'users', tag: 4, type: LIKE_USER, repeated: true },
]);

/** 点赞统计（用户列表在 tag 5）。 */
const VOTE_INFO = message([
  { name: 'totalCount', tag: 1, type: 'uint32' },
  { name: 'newCount', tag: 2, type: 'uint32' },
  { name: 'newNearbyCount', tag: 3, type: 'uint32' },
  { name: 'lastVisitTime', tag: 4, type: 'uint32' },
  { name: 'users', tag: 5, type: LIKE_USER, repeated: true },
]);

const USER_LIKE_INFO = message([
  { name: 'uid', tag: 1, type: 'string' },
  { name: 'time', tag: 2, type: 'uint64' },
  { name: 'favoriteInfo', tag: 3, type: FAVORITE_INFO },
  { name: 'voteInfo', tag: 4, type: VOTE_INFO },
]);

const LIKE_RESP = message([
  { name: 'userLikeInfos', tag: 1, type: USER_LIKE_INFO, repeated: true },
  { name: 'field2', tag: 2, type: 'uint32' },
]);

export interface InteractionCounts {
  totalCount: number;
  newCount: number;
  todayCount: number;
  lastTime: number;
}

export interface LikeUserInfo {
  uid: string;
  src: number;
  latestTime: number;
  count: number;
  giftCount: number;
  customId: number;
  lastCharged: number;
  availableCount: number;
  todayVotedCount: number;
  nick: string;
  gender: number;
  age: number;
  isFriend: boolean;
  isVip: boolean;
  isSvip: boolean;
}

export interface LikeInfo {
  uid: string;
  time: number;
  /** 收藏 */
  favoriteInfo: InteractionCounts & { users: LikeUserInfo[] };
  /** 点赞 */
  voteInfo: InteractionCounts & {
    newNearbyCount: number;
    lastVisitTime: number;
    users: LikeUserInfo[];
  };
}

function readInteraction(v: unknown): InteractionCounts {
  const o = (v as Record<string, unknown> | undefined) ?? {};
  return {
    totalCount: toInt(o.totalCount),
    newCount: toInt(o.newCount),
    todayCount: toInt(o.todayCount),
    lastTime: toInt(o.lastTime),
  };
}

function readLikeUsers(v: unknown): LikeUserInfo[] {
  return ((v as Record<string, unknown>[] | undefined) ?? []).map((row) => ({
    uid: typeof row.uid === 'string' ? row.uid : '',
    src: toInt(row.src),
    latestTime: toInt(row.latestTime),
    count: toInt(row.count),
    giftCount: toInt(row.giftCount),
    customId: toInt(row.customId),
    lastCharged: toInt(row.lastCharged),
    availableCount: toInt(row.availableCount),
    todayVotedCount: toInt(row.todayVotedCount),
    nick: typeof row.nick === 'string' ? row.nick : '',
    gender: toInt(row.gender),
    age: toInt(row.age),
    isFriend: row.isFriend === true,
    isVip: row.isVip === true,
    isSvip: row.isSvip === true,
  }));
}

export namespace GetProfileLike {
  export const command = 0x7ed;
  export const subCommand = 12;
  // 0x7ed_12 不在 LagrangeV2 签名白名单里，needSign = false。
  export const reqSchema = LIKE_REQ;
  export const respSchema = LIKE_RESP;

  export interface Params {
    targetUid: string;
    start?: number;
    limit?: number;
    /** 查自己走 13，查别人走 12。 */
    self?: boolean;
  }

  export const resolveSubCommand = (p: Params): number => (p.self ? 13 : 12);

  export const serialize = (p: Params): Record<string, unknown> => {
    if (!p.targetUid) throw new Error('target uid not found');
    return {
      targetUid: p.targetUid,
      basic: 1,
      vote: 1,
      favorite: 1,
      start: p.start ?? 0,
      userProfile: 1,
      limit: p.limit ?? 10,
    };
  };

  export const deserialize = (body: Record<string, unknown>, targetUid?: string): LikeInfo => {
    const infos = body.userLikeInfos as Record<string, unknown>[] | undefined;
    const data = infos?.[0];
    if (!data) throw new Error('get profile like info empty');
    // 实测 0a00100a 的单个空对象按零处理，不将其他缺 UID 的数据绑定到目标。
    const emptyResult = body.field2 === 10 && infos?.length === 1 && !Object.keys(data).length;
    const favorite = (data.favoriteInfo ?? {}) as Record<string, unknown>;
    const vote = (data.voteInfo ?? {}) as Record<string, unknown>;
    return {
      uid: (data.uid as string) ?? (emptyResult ? targetUid : undefined) ?? '',
      time: toInt(data.time),
      favoriteInfo: {
        ...readInteraction(favorite),
        users: readLikeUsers(favorite.users),
      },
      voteInfo: {
        ...readInteraction(vote),
        newNearbyCount: toInt(vote.newNearbyCount),
        lastVisitTime: toInt(vote.lastVisitTime),
        users: readLikeUsers(vote.users),
      },
    };
  };

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<LikeInfo> =>
    invokeOidb(
      nt,
      pid,
      {
        ...GetProfileLike,
        deserialize: (body) => deserialize(body, params.targetUid),
      } satisfies OidbSpec<Params, LikeInfo>,
      params,
    );
}
