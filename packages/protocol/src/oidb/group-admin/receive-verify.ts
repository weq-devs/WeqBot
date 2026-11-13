/**
 * 管理员「接收验证」（入群/加好友是否需要管理员验证）：写 0x904_1 / 读 0xfe7_4。
 *
 * 搬运自 SnowLuma `packages/protocol/src/oidb-services/group-admin/{set,get}-admin-receive-verify.ts`
 * （2026-11-13），改为 WeqBot 的 `message()` schema 写法。
 *
 * 读取用 uid 形态（`uinForm=false`），并且**要求调用方提供 uid** —— 这条命令的
 * 请求体里只有 uid，没有 uin 槽位。返回值三态：`null` = 服务端没给结论，
 * `true` / `false` = 明确状态（`memberFlagExt` 的 bit 6 为 0 表示开启）。
 *
 * 签名：两条都不在 WeQ 的 SIGN_RULES 里（SnowLuma 也未记录），**三端待实测**。
 */

import { message } from '../../protobuf';
import { invokeOidb, type OidbSpec } from '../invoke';
import { toInt } from '../shared';
import type { OidbNative } from '../../transport';
import { requireGroupId } from './shared';

const RECEIVE_VERIFY_OPERATION = message([
  { name: 'adminUins', tag: 1, type: 'uint64', repeated: true },
  { name: 'authority', tag: 2, type: 'uint32' },
  { name: 'operate', tag: 3, type: 'uint32' },
]);

const SET_RECEIVE_VERIFY_REQ = message([
  { name: 'groupCode', tag: 1, type: 'uint64' },
  { name: 'operation', tag: 2, type: RECEIVE_VERIFY_OPERATION },
]);

const RECEIVE_VERIFY_RESULT = message([
  { name: 'successfulUins', tag: 1, type: 'uint64', repeated: true },
]);

const SET_RECEIVE_VERIFY_RESP = message([
  { name: 'groupCode', tag: 1, type: 'uint64' },
  { name: 'result', tag: 2, type: RECEIVE_VERIFY_RESULT },
]);

const RECEIVE_VERIFY_IDENTITY = message([
  { name: 'uid', tag: 2, type: 'string' },
  { name: 'uin', tag: 4, type: 'uint64' },
]);

const GET_RECEIVE_VERIFY_FILTER = message([{ name: 'memberFlagExt', tag: 104, type: 'uint32' }]);

const GET_RECEIVE_VERIFY_REQ = message([
  { name: 'groupCode', tag: 1, type: 'uint64' },
  { name: 'field2', tag: 2, type: 'uint32' },
  { name: 'field3', tag: 3, type: 'uint32' },
  { name: 'filter', tag: 4, type: GET_RECEIVE_VERIFY_FILTER },
  { name: 'members', tag: 5, type: RECEIVE_VERIFY_IDENTITY, repeated: true },
]);

const GET_RECEIVE_VERIFY_MEMBER = message([
  { name: 'identity', tag: 1, type: RECEIVE_VERIFY_IDENTITY },
  { name: 'memberFlagExt', tag: 104, type: 'uint32' },
]);

const GET_RECEIVE_VERIFY_RESP = message([
  { name: 'groupCode', tag: 1, type: 'uint64' },
  { name: 'members', tag: 2, type: GET_RECEIVE_VERIFY_MEMBER, repeated: true },
]);

/** `memberFlagExt` 的 bit 6 = 「关闭验证」。 */
const RECEIVE_VERIFY_DISABLED_FLAG = 64;

export interface SetAdminReceiveVerifyParams {
  groupId: number;
  userId: number;
  enable: boolean;
}

export namespace SetAdminReceiveVerify {
  export const command = 0x904;
  export const subCommand = 1;
  export const uinForm = true;

  export const reqSchema = SET_RECEIVE_VERIFY_REQ;
  export const respSchema = SET_RECEIVE_VERIFY_RESP;

  export function serialize(params: SetAdminReceiveVerifyParams): Record<string, unknown> {
    return {
      groupCode: BigInt(requireGroupId(params.groupId)),
      operation: {
        adminUins: [BigInt(params.userId)],
        authority: 1,
        operate: params.enable ? 1 : 0,
      },
    };
  }

  export function deserialize(
    body: Record<string, unknown>,
    params: SetAdminReceiveVerifyParams,
  ): void {
    if (toInt(body.groupCode) !== params.groupId) {
      throw new Error('管理员接收验证回包的群号缺失或不匹配');
    }
    const successful = (
      ((body.result as Record<string, unknown> | undefined)?.successfulUins as
        | unknown[]
        | undefined) ?? []
    ).map((value) => toInt(value));
    if (!successful.includes(params.userId)) {
      throw new Error('管理员接收验证回包没有确认目标成员');
    }
  }

  export function invoke(
    nt: OidbNative,
    sessionId: number,
    params: SetAdminReceiveVerifyParams,
  ): Promise<void> {
    return invokeOidb(
      nt,
      sessionId,
      SetAdminReceiveVerify as unknown as OidbSpec<SetAdminReceiveVerifyParams, void>,
      params,
    );
  }
}

export interface GetAdminReceiveVerifyParams {
  groupId: number;
  /** 目标成员的 uid（`u_...`）；这条命令的请求体只有 uid。 */
  targetUid: string;
  /** 目标成员的 QQ 号，仅用于校验回包；不传则跳过校验。 */
  userId?: number;
}

export namespace GetAdminReceiveVerify {
  export const command = 0xfe7;
  export const subCommand = 4;
  export const uinForm = false;

  export const reqSchema = GET_RECEIVE_VERIFY_REQ;
  export const respSchema = GET_RECEIVE_VERIFY_RESP;

  export function serialize(params: GetAdminReceiveVerifyParams): Record<string, unknown> {
    if (!params.targetUid.trim()) throw new Error('查询管理员接收验证需要目标 uid');
    return {
      groupCode: BigInt(requireGroupId(params.groupId)),
      field2: 3,
      field3: 0,
      filter: { memberFlagExt: 1 },
      members: [{ uid: params.targetUid }],
    };
  }

  export function deserialize(
    body: Record<string, unknown>,
    params: GetAdminReceiveVerifyParams,
  ): boolean | null {
    if (toInt(body.groupCode) !== params.groupId) {
      throw new Error('管理员接收验证回包的群号缺失或不匹配');
    }

    const members = ((body.members as Record<string, unknown>[] | undefined) ?? []).filter(
      (member) =>
        (member.identity as Record<string, unknown> | undefined)?.uid === params.targetUid,
    );
    if (members.length !== 1) throw new Error('管理员接收验证回包必须恰好包含一个匹配成员');

    const member = members[0]!;
    const identity = (member.identity as Record<string, unknown> | undefined) ?? {};
    if (params.userId !== undefined && identity.uin !== undefined) {
      if (toInt(identity.uin) !== params.userId) {
        throw new Error('管理员接收验证回包的成员 uin 不匹配');
      }
    }

    // 缺失数据保持 unknown；显式 0 才是「已知开启」。
    if (member.memberFlagExt === undefined) return null;
    return (toInt(member.memberFlagExt) & RECEIVE_VERIFY_DISABLED_FLAG) === 0;
  }

  export function invoke(
    nt: OidbNative,
    sessionId: number,
    params: GetAdminReceiveVerifyParams,
  ): Promise<boolean | null> {
    return invokeOidb(
      nt,
      sessionId,
      GetAdminReceiveVerify as unknown as OidbSpec<GetAdminReceiveVerifyParams, boolean | null>,
      params,
    );
  }
}
