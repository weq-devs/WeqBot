/**
 * 管理员权限：读取 0x9164_2 / 写入 0x9c1c_2。
 *
 * 搬运自 SnowLuma `packages/protocol/src/oidb-services/group-admin/{get,set}-admin-permissions.ts`
 * （2026-11-13），改为 WeqBot 的 `message()` schema 写法。
 *
 * 权限项用数字区分：`item=1` 是踢人（value 1 = 允许 / 2 = 禁止 / 0 = 未设置），
 * `item=2` 是撤回成员消息。开启踢人时 `extra` 里带每日上限 `maxKickPerDay`（0 = 不限）。
 *
 * 签名：两条都不在 WeQ 的 SIGN_RULES 里（SnowLuma 也未记录），**三端待实测**。
 */

import { decode, encode, message } from '../../protobuf';
import { invokeOidb, type OidbSpec } from '../invoke';
import { toInt } from '../shared';
import type { OidbNative } from '../../transport';
import { requireGroupId } from './shared';

const KICK_LIMIT = message([{ name: 'maxKickPerDay', tag: 1, type: 'uint32' }]);

const PERMISSION_ITEM = message([
  { name: 'item', tag: 1, type: 'uint32' },
  { name: 'value', tag: 2, type: 'uint32' },
  { name: 'extra', tag: 3, type: 'bytes' },
]);

const PERMISSION_ITEMS = message([
  { name: 'items', tag: 1, type: PERMISSION_ITEM, repeated: true },
]);

const PERMISSIONS_EXT = message([{ name: 'permissions', tag: 52, type: PERMISSION_ITEMS }]);

const PERMISSIONS_MEMBER = message([
  { name: 'memberUin', tag: 1, type: 'uint64' },
  { name: 'ext', tag: 3, type: PERMISSIONS_EXT },
]);

const GET_PERMISSIONS_FILTER = message([{ name: 'permissions', tag: 52, type: 'bytes' }]);

const GET_PERMISSIONS_REQ = message([
  { name: 'groupCode', tag: 1, type: 'uint64' },
  { name: 'memberUins', tag: 2, type: 'uint64', repeated: true },
  { name: 'filter', tag: 4, type: GET_PERMISSIONS_FILTER },
]);

const GET_PERMISSIONS_RESP = message([
  { name: 'groupCode', tag: 1, type: 'uint64' },
  { name: 'members', tag: 3, type: PERMISSIONS_MEMBER, repeated: true },
]);

const SET_PERMISSIONS_REQ = message([
  { name: 'groupCode', tag: 1, type: 'uint64' },
  { name: 'memberUin', tag: 2, type: 'uint64' },
  { name: 'permissions', tag: 3, type: PERMISSION_ITEM, repeated: true },
]);

const PERMISSION_ITEM_KICK = 1;
const PERMISSION_ITEM_RECALL = 2;

/** 服务端接受的每日踢人上限；开通踢人时必须从中选一个（0 = 不限）。 */
export const KICK_MEMBER_PER_DAY_CHOICES = [0, 5, 10, 20, 50, 100, 200] as const;

export interface AdminPermissionsSnapshot {
  /** `null` = 未设置（不是「禁止」）。 */
  recallMemberMessage: boolean | null;
  kickMember: boolean | null;
  kickMemberPerDay: number | null;
}

export interface GetAdminPermissionsParams {
  groupId: number;
  userId: number;
}

export namespace GetAdminPermissions {
  export const command = 0x9164;
  export const subCommand = 2;
  export const uinForm = true;

  export const reqSchema = GET_PERMISSIONS_REQ;
  export const respSchema = GET_PERMISSIONS_RESP;

  export function serialize(params: GetAdminPermissionsParams): Record<string, unknown> {
    return {
      groupCode: BigInt(requireGroupId(params.groupId)),
      memberUins: [BigInt(params.userId)],
      filter: { permissions: new Uint8Array([1]) },
    };
  }

  export function deserialize(
    body: Record<string, unknown>,
    params: GetAdminPermissionsParams,
  ): AdminPermissionsSnapshot {
    const groupCode = toInt(body.groupCode);
    if (groupCode !== params.groupId) throw new Error('管理员权限回包的群号缺失或不匹配');

    const members = ((body.members as Record<string, unknown>[] | undefined) ?? []).filter(
      (member) => toInt(member.memberUin) === params.userId,
    );
    if (members.length !== 1) throw new Error('管理员权限回包必须恰好包含一个匹配成员');

    const snapshot: AdminPermissionsSnapshot = {
      recallMemberMessage: null,
      kickMember: null,
      kickMemberPerDay: null,
    };
    const seen = new Set<number>();
    const ext = (members[0]!.ext as Record<string, unknown> | undefined) ?? {};
    const permissions = (ext.permissions as Record<string, unknown> | undefined) ?? {};
    const items = (permissions.items as Record<string, unknown>[] | undefined) ?? [];

    for (const permission of items) {
      const id = toInt(permission.item);
      if (id !== PERMISSION_ITEM_KICK && id !== PERMISSION_ITEM_RECALL) continue;
      if (seen.has(id)) throw new Error(`管理员权限回包出现重复 item ${id}`);
      seen.add(id);

      const value = toInt(permission.value);
      if (value !== 0 && value !== 1 && value !== 2) {
        throw new Error(`管理员权限 ${id} 的值不受支持: ${value}`);
      }
      // 0 或缺失都不构成「已生效」的权限。
      const enabled = value === 0 ? null : value === 1;

      if (id === PERMISSION_ITEM_RECALL) {
        snapshot.recallMemberMessage = enabled;
      } else {
        snapshot.kickMember = enabled;
        if (enabled) {
          const extra = permission.extra;
          snapshot.kickMemberPerDay =
            extra instanceof Uint8Array && extra.length > 0
              ? toInt(decode(KICK_LIMIT, extra).maxKickPerDay)
              : 0;
        }
      }
    }

    return snapshot;
  }

  export function invoke(
    nt: OidbNative,
    sessionId: number,
    params: GetAdminPermissionsParams,
  ): Promise<AdminPermissionsSnapshot> {
    return invokeOidb(
      nt,
      sessionId,
      GetAdminPermissions as unknown as OidbSpec<
        GetAdminPermissionsParams,
        AdminPermissionsSnapshot
      >,
      params,
    );
  }
}

export interface GroupAdminPermissionPatch {
  recallMemberMessage?: boolean;
  kickMember?: boolean;
  /** 开启踢人时必填；0 显式表示不限。 */
  kickMemberPerDay?: number;
}

export interface SetAdminPermissionsParams extends GroupAdminPermissionPatch {
  groupId: number;
  userId: number;
}

export namespace SetAdminPermissions {
  export const command = 0x9c1c;
  export const subCommand = 2;
  export const uinForm = false;

  export const reqSchema = SET_PERMISSIONS_REQ;
  export const respSchema = message([]);

  export function serialize(params: SetAdminPermissionsParams): Record<string, unknown> {
    if (params.recallMemberMessage === undefined && params.kickMember === undefined) {
      throw new Error('至少要指定一项管理员权限');
    }

    if (params.kickMember === true) {
      if (
        params.kickMemberPerDay === undefined ||
        !(KICK_MEMBER_PER_DAY_CHOICES as readonly number[]).includes(params.kickMemberPerDay)
      ) {
        throw new Error(
          `开启踢人需要 kickMemberPerDay：${KICK_MEMBER_PER_DAY_CHOICES.join(' / ')}`,
        );
      }
    } else if (params.kickMemberPerDay !== undefined) {
      throw new Error('kickMemberPerDay 只在 kickMember=true 时有意义');
    }

    const permissions: Record<string, unknown>[] = [];
    if (params.kickMember !== undefined) {
      permissions.push({
        item: PERMISSION_ITEM_KICK,
        value: params.kickMember ? 1 : 2,
        extra: params.kickMember
          ? encode(KICK_LIMIT, { maxKickPerDay: params.kickMemberPerDay })
          : undefined,
      });
    }
    if (params.recallMemberMessage !== undefined) {
      permissions.push({
        item: PERMISSION_ITEM_RECALL,
        value: params.recallMemberMessage ? 1 : 2,
      });
    }

    return {
      groupCode: BigInt(requireGroupId(params.groupId)),
      memberUin: BigInt(params.userId),
      permissions,
    };
  }

  export function deserialize(): void {}

  export function invoke(
    nt: OidbNative,
    sessionId: number,
    params: SetAdminPermissionsParams,
  ): Promise<void> {
    return invokeOidb(
      nt,
      sessionId,
      SetAdminPermissions as unknown as OidbSpec<SetAdminPermissionsParams, void>,
      params,
    );
  }
}
