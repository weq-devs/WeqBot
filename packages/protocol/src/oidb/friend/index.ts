/**
 * 好友关系写操作：删好友、清备注、可疑好友申请（列表 / 同意 / 拒绝）。
 *
 * 搬运自 SnowLuma `packages/protocol/src/oidb-services/friend/*`（2026-11-13），
 * 改为 WeqBot 的 `message()` schema 写法。
 *
 * 与 `oidb/request/friend-requests.ts`（**陌生人**加好友申请，0xb5d_44）不同：
 * 这里处理的是「可能认识的人 / 被过滤的好友申请」（doubt buddy，0xd69 / 0xd72）。
 *
 * 签名：这五条都不在 WeQ 的 SIGN_RULES 里（SnowLuma 也未记录），**三端待实测**。
 * `uinForm` 见各自的常量 —— 它决定 OIDB 信封的 `reserved` 是 0 还是 1。
 */

import { message } from '../../protobuf';
import { invokeOidb, type OidbSpec } from '../invoke';

export {
  GetUnidirectionalFriendList,
  type GetUnidirectionalFriendListParams,
  type UnidirectionalFriendEntry,
} from './unidirectional';
import { toInt } from '../shared';
import type { OidbNative } from '../../transport';

// ───────────────────────── 删好友 — 0x126b_0 ─────────────────────────

const DELETE_FRIEND_LEVEL2 = message([
  { name: 'field1', tag: 1, type: 'uint32' },
  { name: 'field2', tag: 2, type: 'uint32' },
  { name: 'field3', tag: 3, type: 'uint32' },
]);

const DELETE_FRIEND_LEVEL1 = message([
  { name: 'field1', tag: 1, type: 'uint32' },
  { name: 'field2', tag: 2, type: 'uint32' },
  { name: 'field3', tag: 3, type: DELETE_FRIEND_LEVEL2 },
]);

const DELETE_FRIEND_TARGET = message([
  { name: 'targetUid', tag: 1, type: 'string' },
  { name: 'field2', tag: 2, type: DELETE_FRIEND_LEVEL1 },
  { name: 'block', tag: 3, type: 'bool' },
  { name: 'field4', tag: 4, type: 'bool' },
]);

const DELETE_FRIEND_REQ = message([{ name: 'field1', tag: 1, type: DELETE_FRIEND_TARGET }]);

/**
 * 服务端判别用的魔数。它们不是 SnowLuma 的发明 —— 与 QQ 客户端发出的字节
 * 一致，任何一位错都会被拒。**不要**试着「简化」这层嵌套。
 */
const DELETE_FRIEND_MAGIC = {
  field1: 130,
  field2: 109,
  inner: { field1: 8, field2: 8, field3: 50 },
} as const;

export interface DeleteFriendParams {
  /** 对方 uid（`u_...`），不是 QQ 号。 */
  targetUid: string;
  /** 同时拉黑。默认 false。 */
  block?: boolean;
}

export namespace DeleteFriend {
  export const command = 0x126b;
  export const subCommand = 0;
  export const uinForm = false;

  export const reqSchema = DELETE_FRIEND_REQ;
  export const respSchema = message([]);

  export function serialize(params: DeleteFriendParams): Record<string, unknown> {
    if (!params.targetUid.trim()) throw new Error('删好友需要对方 uid');
    return {
      field1: {
        targetUid: params.targetUid,
        field2: {
          field1: DELETE_FRIEND_MAGIC.field1,
          field2: DELETE_FRIEND_MAGIC.field2,
          field3: DELETE_FRIEND_MAGIC.inner,
        },
        block: params.block ?? false,
        field4: true,
      },
    };
  }

  export function deserialize(): void {}

  export function invoke(
    nt: OidbNative,
    sessionId: number,
    params: DeleteFriendParams,
  ): Promise<void> {
    return invokeOidb(nt, sessionId, DeleteFriend as OidbSpec<DeleteFriendParams, void>, params);
  }
}

// ───────────────────────── 清好友备注 — 0x912f_0 ─────────────────────────

const FRIEND_REMARK_TARGET = message([
  { name: 'targetUin', tag: 3, type: 'uint64' },
  { name: 'targetUid', tag: 7, type: 'string' },
]);

const CLEAR_FRIEND_REMARK_REQ = message([{ name: 'target', tag: 1, type: FRIEND_REMARK_TARGET }]);

export interface ClearFriendRemarkParams {
  targetUid: string;
}

export namespace ClearFriendRemark {
  export const command = 0x912f;
  export const subCommand = 0;
  export const uinForm = false;

  export const reqSchema = CLEAR_FRIEND_REMARK_REQ;
  export const respSchema = message([]);

  export function serialize(params: ClearFriendRemarkParams): Record<string, unknown> {
    if (!params.targetUid.trim()) throw new Error('清好友备注需要对方 uid');
    return { target: { targetUid: params.targetUid } };
  }

  export function deserialize(): void {}

  export function invoke(
    nt: OidbNative,
    sessionId: number,
    params: ClearFriendRemarkParams,
  ): Promise<void> {
    return invokeOidb(
      nt,
      sessionId,
      ClearFriendRemark as OidbSpec<ClearFriendRemarkParams, void>,
      params,
    );
  }
}

// ───────────────────── 可疑好友申请列表 / 拒绝 — 0xd69_0 ─────────────────────

const DOUBT_ITEM = message([
  { name: 'uid', tag: 1, type: 'string' },
  { name: 'nick', tag: 2, type: 'string' },
  { name: 'age', tag: 3, type: 'uint32' },
  { name: 'sex', tag: 4, type: 'uint32' },
  { name: 'msg', tag: 5, type: 'string' },
  { name: 'source', tag: 6, type: 'string' },
  { name: 'reason', tag: 7, type: 'string' },
  { name: 'reqTime', tag: 8, type: 'uint64' },
  { name: 'groupCode', tag: 9, type: 'uint64' },
  { name: 'commFriendNum', tag: 10, type: 'uint32' },
]);

const DOUBT_LIST_BODY = message([
  { name: 'list', tag: 1, type: DOUBT_ITEM, repeated: true },
  { name: 'reason', tag: 2, type: 'string' },
]);

const DOUBT_GET_RESP = message([
  { name: 'status', tag: 1, type: 'uint32' },
  { name: 'body', tag: 2, type: DOUBT_LIST_BODY },
]);

/**
 * Linux 3.2.32 把账号写在 tag 1 的 varint 里（没有 string uid），另一批构建
 * 却在 tag 1 放 string。同一份字节用两套 schema 各解一次再合并，见 `deserialize`。
 */
const DOUBT_ITEM_UIN_ON_TAG1 = message([{ name: 'uin', tag: 1, type: 'uint64' }]);
const DOUBT_LIST_BODY_UIN = message([
  { name: 'list', tag: 1, type: DOUBT_ITEM_UIN_ON_TAG1, repeated: true },
]);
const DOUBT_GET_RESP_UIN = message([
  { name: 'status', tag: 1, type: 'uint32' },
  { name: 'body', tag: 2, type: DOUBT_LIST_BODY_UIN },
]);

const DOUBT_GET_REQ_INNER = message([
  { name: 'num', tag: 1, type: 'uint32' },
  { name: 'uk', tag: 2, type: 'string' },
]);

const DOUBT_GET_REQ = message([
  { name: 'field1', tag: 1, type: 'uint32' },
  { name: 'inner', tag: 2, type: DOUBT_GET_REQ_INNER },
]);

const DOUBT_DEL_REQ_INNER = message([{ name: 'uid', tag: 1, type: 'string' }]);

const DOUBT_DEL_REQ = message([
  { name: 'field1', tag: 1, type: 'uint32' },
  { name: 'inner', tag: 3, type: DOUBT_DEL_REQ_INNER },
]);

export interface DoubtBuddyRequest {
  /** 回传给同意 / 拒绝时用的不透明 uid。 */
  uid: string;
  userId: number;
  nick: string;
  source: string;
  reason: string;
  msg: string;
  groupCode: string;
  reqTime: number;
}

export interface GetDoubtBuddyReqParams {
  count: number;
  cookie?: string;
}

export namespace GetDoubtBuddyReq {
  export const command = 0xd69;
  export const subCommand = 0;
  /** 列表与拒绝共用这条命令，但信封形态是 uin-form。 */
  export const uinForm = true;

  export const reqSchema = DOUBT_GET_REQ;
  export const respSchema = DOUBT_GET_RESP;
  /** 第二遍解码用：只认 tag 1 的 varint 账号。 */
  export const respSchemaUinTag1 = DOUBT_GET_RESP_UIN;

  export function serialize(params: GetDoubtBuddyReqParams): Record<string, unknown> {
    return { field1: 1, inner: { num: params.count, uk: params.cookie ?? '' } };
  }

  export function deserialize(
    body: Record<string, unknown>,
    numericBody?: Record<string, unknown>,
  ): DoubtBuddyRequest[] {
    const items =
      ((body.body as Record<string, unknown> | undefined)?.list as
        | Record<string, unknown>[]
        | undefined) ?? [];
    const numericItems =
      ((numericBody?.body as Record<string, unknown> | undefined)?.list as
        | Record<string, unknown>[]
        | undefined) ?? [];
    return items.map((item, index) => {
      // varint 形态的 uin 在 `numericItems` 里，按索引对齐。
      const uinFromTag1 = toInt(numericItems[index]?.uin);
      return {
        uid: typeof item.uid === 'string' ? item.uid : '',
        userId: uinFromTag1,
        nick: typeof item.nick === 'string' ? item.nick : '',
        source: typeof item.source === 'string' ? item.source : '',
        reason: typeof item.reason === 'string' ? item.reason : '',
        msg: typeof item.msg === 'string' ? item.msg : '',
        groupCode: toInt(item.groupCode) ? String(toInt(item.groupCode)) : '',
        reqTime: toInt(item.reqTime),
      };
    });
  }

  export function invoke(
    nt: OidbNative,
    sessionId: number,
    params: GetDoubtBuddyReqParams,
  ): Promise<DoubtBuddyRequest[]> {
    return invokeOidb(
      nt,
      sessionId,
      GetDoubtBuddyReq as OidbSpec<GetDoubtBuddyReqParams, DoubtBuddyRequest[]>,
      params,
    );
  }
}

export interface RejectDoubtBuddyReqParams {
  /** 申请条目里的 uid。 */
  uid: string;
}

export namespace RejectDoubtBuddyReq {
  export const command = 0xd69;
  export const subCommand = 0;
  export const uinForm = true;

  export const reqSchema = DOUBT_DEL_REQ;
  export const respSchema = message([]);

  export function serialize(params: RejectDoubtBuddyReqParams): Record<string, unknown> {
    return { field1: 3, inner: { uid: params.uid } };
  }

  export function deserialize(): void {}

  export function invoke(
    nt: OidbNative,
    sessionId: number,
    params: RejectDoubtBuddyReqParams,
  ): Promise<void> {
    return invokeOidb(
      nt,
      sessionId,
      RejectDoubtBuddyReq as OidbSpec<RejectDoubtBuddyReqParams, void>,
      params,
    );
  }
}

// ───────────────────── 同意可疑好友申请 — 0xd72_0 ─────────────────────

const DOUBT_APPROVAL_REQ = message([
  { name: 'selfUid', tag: 1, type: 'string' },
  { name: 'targetUid', tag: 2, type: 'string' },
  { name: 'field3', tag: 3, type: 'uint32' },
  { name: 'field4', tag: 4, type: 'string' },
]);

export interface ApproveDoubtBuddyReqParams {
  /** 自己的 uid（`u_...`）；调用方从会话上下文取。 */
  selfUid: string;
  /** 申请人的 uid。 */
  uid: string;
}

export namespace ApproveDoubtBuddyReq {
  export const command = 0xd72;
  export const subCommand = 0;
  export const uinForm = false;

  export const reqSchema = DOUBT_APPROVAL_REQ;
  export const respSchema = message([]);

  export function serialize(params: ApproveDoubtBuddyReqParams): Record<string, unknown> {
    if (!params.uid.trim()) throw new Error('同意可疑好友申请需要申请人 uid');
    if (!params.selfUid.trim()) throw new Error('同意可疑好友申请需要自己的 uid');
    return { selfUid: params.selfUid, targetUid: params.uid, field3: 0, field4: '' };
  }

  export function deserialize(): void {}

  export function invoke(
    nt: OidbNative,
    sessionId: number,
    params: ApproveDoubtBuddyReqParams,
  ): Promise<void> {
    return invokeOidb(
      nt,
      sessionId,
      ApproveDoubtBuddyReq as OidbSpec<ApproveDoubtBuddyReqParams, void>,
      params,
    );
  }
}
