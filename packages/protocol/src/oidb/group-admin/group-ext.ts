/**
 * 群扩展信息（机器人入群选项）：读取 0xef0_1 / 写入 0xf00_3。
 *
 * 搬运自 SnowLuma `packages/protocol/src/oidb-services/group-admin/{get-group-ext-info,modify-group-ext-info}.ts`
 * （2026-11-13），改为 WeqBot 的 `message()` schema 写法。
 *
 * `GroupExtFilter` 只在客户端存在：它决定编码器**要不要写**对应的 EXTInfo
 * 字段 —— 字段出现本身就是写信号，值 0 也是有效写入。所以 `serialize` 只在
 * 调用方显式给了值时才带上字段。
 *
 * 签名：两条都不在 WeQ 的 SIGN_RULES 里（SnowLuma 也未记录），**三端待实测**。
 */

import { message } from '../../protobuf';
import { invokeOidb, type OidbSpec } from '../invoke';
import { toInt } from '../shared';
import { requireGroupId } from './shared';
import type { OidbNative } from '../../transport';

const GROUP_EXT_BODY = message([
  { name: 'inviteRobotMemberSwitch', tag: 29, type: 'uint32' },
  { name: 'inviteRobotMemberExamine', tag: 30, type: 'uint32' },
]);

const GET_GROUP_EXT_FILTER = message([
  { name: 'inviteRobotMemberSwitch', tag: 29, type: 'uint32' },
  { name: 'inviteRobotMemberExamine', tag: 30, type: 'uint32' },
]);

const GET_GROUP_EXT_REQ = message([
  { name: 'groupCodes', tag: 1, type: 'uint64', repeated: true },
  { name: 'filter', tag: 2, type: GET_GROUP_EXT_FILTER },
]);

const GET_GROUP_EXT_ITEM = message([
  { name: 'groupCode', tag: 1, type: 'uint64' },
  { name: 'resultCode', tag: 2, type: 'uint32' },
  { name: 'ext', tag: 3, type: GROUP_EXT_BODY },
]);

const GET_GROUP_EXT_RESP = message([
  { name: 'items', tag: 1, type: GET_GROUP_EXT_ITEM, repeated: true },
]);

const GROUP_EXT_INFO = message([
  { name: 'groupCode', tag: 1, type: 'uint32' },
  { name: 'ext', tag: 2, type: GROUP_EXT_BODY },
]);

const MODIFY_GROUP_EXT_REQ = message([
  { name: 'groupCode', tag: 1, type: 'uint32' },
  { name: 'info', tag: 2, type: GROUP_EXT_INFO },
]);

const MODIFY_GROUP_EXT_RESP = message([
  { name: 'groupCode', tag: 1, type: 'uint32' },
  { name: 'result', tag: 2, type: 'int32' },
]);

export interface GroupExtRobotOption {
  robotMemberSwitch: number;
  robotMemberExamine: number;
}

export interface FetchGroupExtInfoParams {
  groupId: number;
}

export namespace FetchGroupExtInfo {
  export const command = 0xef0;
  export const subCommand = 1;
  export const uinForm = true;

  export const reqSchema = GET_GROUP_EXT_REQ;
  export const respSchema = GET_GROUP_EXT_RESP;

  export function serialize(params: FetchGroupExtInfoParams): Record<string, unknown> {
    return {
      groupCodes: [BigInt(requireGroupId(params.groupId))],
      filter: { inviteRobotMemberSwitch: 1, inviteRobotMemberExamine: 1 },
    };
  }

  export function deserialize(body: Record<string, unknown>): GroupExtRobotOption {
    const items = (body.items as Record<string, unknown>[] | undefined) ?? [];
    const item = items[0];
    if (!item) throw new Error('读不到群机器人入群选项');

    const resultCode = toInt(item.resultCode);
    if (resultCode !== 0) throw new Error(`读不到群机器人入群选项: result=${resultCode}`);

    const ext = (item.ext as Record<string, unknown> | undefined) ?? {};
    return {
      robotMemberSwitch: toInt(ext.inviteRobotMemberSwitch),
      robotMemberExamine: toInt(ext.inviteRobotMemberExamine),
    };
  }

  export function invoke(
    nt: OidbNative,
    sessionId: number,
    params: FetchGroupExtInfoParams,
  ): Promise<GroupExtRobotOption> {
    return invokeOidb(
      nt,
      sessionId,
      FetchGroupExtInfo as OidbSpec<FetchGroupExtInfoParams, GroupExtRobotOption>,
      params,
    );
  }
}

export interface ModifyGroupExtInfoParams {
  groupId: number;
  /** 不传 = 不改这一项（字段不上 wire）。 */
  robotMemberSwitch?: number;
  robotMemberExamine?: number;
}

export namespace ModifyGroupExtInfo {
  export const command = 0xf00;
  export const subCommand = 3;
  export const uinForm = true;

  export const reqSchema = MODIFY_GROUP_EXT_REQ;
  export const respSchema = MODIFY_GROUP_EXT_RESP;

  export function serialize(params: ModifyGroupExtInfoParams): Record<string, unknown> {
    const groupId = requireGroupId(params.groupId);
    const ext: Record<string, unknown> = {};
    if (params.robotMemberSwitch !== undefined)
      ext.inviteRobotMemberSwitch = params.robotMemberSwitch;
    if (params.robotMemberExamine !== undefined) {
      ext.inviteRobotMemberExamine = params.robotMemberExamine;
    }
    return { groupCode: groupId, info: { groupCode: groupId, ext } };
  }

  export function deserialize(body: Record<string, unknown>): void {
    const result = toInt(body.result);
    if (result !== 0) throw new Error(`0xf00_3 修改群扩展信息失败: result=${result}`);
  }

  export function invoke(
    nt: OidbNative,
    sessionId: number,
    params: ModifyGroupExtInfoParams,
  ): Promise<void> {
    return invokeOidb(
      nt,
      sessionId,
      ModifyGroupExtInfo as OidbSpec<ModifyGroupExtInfoParams, void>,
      params,
    );
  }
}
