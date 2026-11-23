/**
 * 群管理设置：单群详情走 0x88D_0，成员邀请写入走 0x89A_8，其余下列设置走 0x89A_0。
 *
 * 搬运自 SnowLuma `packages/protocol/src/oidb-services/group-admin/{set-search,
 * set-member-invite-policy,set-new-member-history-visibility,set-member-permission}.ts`
 * 与 `contacts/fetch-group-detail.ts`（2026-11-15），改成 WeqBot 的 `message()` 写法。
 *
 * 0x89A 的 settings 共用同一消息结构，字段按用途分：
 *   - 搜索开关 tag 35/36；
 *   - 成员权限 tag 23/24，成员邀请启用时同包写审核 tag 23/24 与开关 tag 29；
 *   - 新成员历史 tag 42/43。
 * 每次只带本次要改的字段，未带的字段不下发。
 *
 * 签名：0x89A_0 与 0x89A_8 已在 SIGN_RULES。
 */

import { message } from '../../protobuf';
import { invokeOidb, type OidbSpec } from '../invoke';
import { toInt } from '../shared';
import type { OidbNative } from '../../transport';
import {
  GROUP_ROBOT_SETTING_FIELDS,
  type GroupExtRobotOption,
  readGroupRobotFields,
} from './group-ext';
import { requireGroupId } from './shared';

// ───────────────────────── 单群详情 — 0x88D_0 ─────────────────────────

const DETAIL_FLAGS = message([
  { name: 'ownerUid', tag: 1, type: 'bool' },
  { name: 'createTime', tag: 2, type: 'bool' },
  { name: 'groupFlagExt', tag: 4, type: 'bool' },
  { name: 'maxMemberCount', tag: 5, type: 'bool' },
  { name: 'memberCount', tag: 6, type: 'bool' },
  { name: 'addType', tag: 7, type: 'bool' },
  { name: 'level', tag: 10, type: 'bool' },
  { name: 'name', tag: 15, type: 'string', force: true },
  { name: 'noticePreview', tag: 16, type: 'string', force: true },
  { name: 'uin', tag: 21, type: 'bool' },
  { name: 'lastSequence', tag: 22, type: 'bool' },
  { name: 'lastMessageTime', tag: 23, type: 'bool' },
  { name: 'question', tag: 24, type: 'string', force: true },
  { name: 'answer', tag: 25, type: 'string', force: true },
  { name: 'maxAdminCount', tag: 29, type: 'string', force: true },
  { name: 'shutUpAllTimestamp', tag: 45, type: 'bool' },
  { name: 'privilegeFlag', tag: 56, type: 'bool' },
  { name: 'groupFlagExt4', tag: 101, type: 'bool' },
  { name: 'noFingerOpen', tag: 82, type: 'bool' },
  { name: 'noCodeFingerOpen', tag: 83, type: 'bool' },
  { name: 'robotSettings', tag: 109, type: GROUP_ROBOT_SETTING_FIELDS },
]);

const DETAIL_REQ = message([
  { name: 'field1', tag: 1, type: 'uint32' },
  {
    name: 'config',
    tag: 2,
    type: message([
      { name: 'uin', tag: 1, type: 'uint64' },
      { name: 'flags', tag: 2, type: DETAIL_FLAGS },
    ]),
  },
]);

const DETAIL_RESULTS = message([
  { name: 'ownerUid', tag: 1, type: 'string' },
  { name: 'createTime', tag: 2, type: 'uint64' },
  { name: 'groupFlagExt', tag: 4, type: 'uint32' },
  { name: 'maxMemberCount', tag: 5, type: 'uint64' },
  { name: 'memberCount', tag: 6, type: 'uint64' },
  { name: 'addType', tag: 7, type: 'uint32' },
  { name: 'level', tag: 10, type: 'uint64' },
  { name: 'name', tag: 15, type: 'string' },
  { name: 'noticePreview', tag: 16, type: 'string' },
  { name: 'uin', tag: 21, type: 'uint64' },
  { name: 'lastSequence', tag: 22, type: 'uint64' },
  { name: 'lastMessageTime', tag: 23, type: 'uint64' },
  { name: 'question', tag: 24, type: 'string' },
  { name: 'answer', tag: 25, type: 'string' },
  { name: 'maxAdminCount', tag: 29, type: 'uint64' },
  { name: 'shutUpAllTimestamp', tag: 45, type: 'uint32' },
  { name: 'privilegeFlag', tag: 56, type: 'uint32' },
  { name: 'groupFlagExt4', tag: 101, type: 'uint32' },
  { name: 'noFingerOpen', tag: 82, type: 'uint32' },
  { name: 'noCodeFingerOpen', tag: 83, type: 'uint32' },
  { name: 'robotSettings', tag: 109, type: GROUP_ROBOT_SETTING_FIELDS },
]);

const DETAIL_RESP = message([
  {
    name: 'groupInfo',
    tag: 1,
    type: message([
      { name: 'uin', tag: 1, type: 'uint64' },
      { name: 'result', tag: 2, type: 'uint32' },
      { name: 'results', tag: 3, type: DETAIL_RESULTS },
    ]),
  },
]);

export interface GroupDetailInfo {
  groupId: number;
  name: string;
  addType: number;
  question: string;
  answer: string;
  privilegeFlag: number;
  groupFlagExt4: number;
  noFingerOpen: number;
  noCodeFingerOpen: number;
  robotSettings?: GroupExtRobotOption['settingFields'];
  settingFields?: Partial<
    Record<
      'privilegeFlag' | 'groupFlagExt' | 'groupFlagExt4' | 'noFingerOpen' | 'noCodeFingerOpen',
      number
    >
  >;
}

export namespace FetchGroupDetail {
  export const command = 0x88d;
  export const subCommand = 0;
  export const reqSchema = DETAIL_REQ;
  export const respSchema = DETAIL_RESP;

  export type Params = { groupId: number; includeRobotSettings?: boolean; includeAnswer?: boolean };

  export const serialize = (p: Params): Record<string, unknown> => ({
    field1: 537099973,
    config: {
      uin: BigInt(requireGroupId(p.groupId)),
      flags: {
        ownerUid: true,
        createTime: true,
        groupFlagExt: true,
        maxMemberCount: true,
        memberCount: true,
        addType: true,
        level: true,
        name: '',
        noticePreview: '',
        uin: true,
        lastSequence: true,
        lastMessageTime: true,
        question: '',
        ...(p.includeAnswer !== false ? { answer: '' } : {}),
        maxAdminCount: '',
        shutUpAllTimestamp: true,
        privilegeFlag: true,
        groupFlagExt4: true,
        noFingerOpen: true,
        noCodeFingerOpen: true,
        ...(p.includeRobotSettings
          ? { robotSettings: { inviteRobotMemberSwitch: 1, inviteRobotMemberExamine: 1 } }
          : {}),
      },
    },
  });

  export const deserialize = (body: Record<string, unknown>, params?: Params): GroupDetailInfo => {
    const info = body.groupInfo as Record<string, unknown> | undefined;
    const result = toInt(info?.result);
    if (result !== 0) throw new Error(`0x88D_0 群资料读取失败（${result}）`);
    const results = info?.results as Record<string, unknown> | undefined;
    if (!results) throw new Error('0x88D_0 回包缺少 groupInfo.results');
    // 外层是请求使用的公开群号，详情 tag 21 是内部 group UIN。
    const groupId = toInt(info?.uin);
    if (!groupId || (params && groupId !== params.groupId))
      throw new Error('0x88D_0 回包的群号不一致');
    return {
      groupId,
      name: typeof results.name === 'string' ? results.name : '',
      addType: toInt(results.addType),
      question: typeof results.question === 'string' ? results.question : '',
      answer: typeof results.answer === 'string' ? results.answer : '',
      privilegeFlag: toInt(results.privilegeFlag),
      groupFlagExt4: toInt(results.groupFlagExt4),
      noFingerOpen: toInt(results.noFingerOpen),
      noCodeFingerOpen: toInt(results.noCodeFingerOpen),
      robotSettings: readGroupRobotFields(results.robotSettings),
      settingFields: Object.fromEntries(
        ['privilegeFlag', 'groupFlagExt', 'groupFlagExt4', 'noFingerOpen', 'noCodeFingerOpen']
          .filter((key) => results[key] !== undefined)
          .map((key) => [key, toInt(results[key])]),
      ),
    };
  };

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<GroupDetailInfo> =>
    invokeOidb(nt, pid, FetchGroupDetail as OidbSpec<Params, GroupDetailInfo>, params);
}

// ───────────────────────── 共用的 0x89A settings ─────────────────────────

const WRITE_SETTINGS = message([
  { name: 'addType', tag: 16, type: 'uint32' },
  { name: 'groupQuestion', tag: 30, type: 'string', force: true },
  { name: 'groupAnswer', tag: 31, type: 'string', force: true },
  { name: 'appPrivilegeFlag', tag: 23, type: 'uint32', force: true },
  { name: 'appPrivilegeMask', tag: 24, type: 'uint32', force: true },
  { name: 'allowMemberInvite', tag: 29, type: 'uint32', force: true },
  { name: 'noFingerOpen', tag: 35, type: 'uint32', force: true },
  { name: 'noCodeFingerOpen', tag: 36, type: 'uint32', force: true },
  { name: 'groupFlagExt4', tag: 42, type: 'uint32', force: true },
  { name: 'groupFlagExt4Mask', tag: 43, type: 'uint32', force: true },
]);

const WRITE_REQ = message([
  { name: 'groupUin', tag: 1, type: 'uint64' },
  { name: 'settings', tag: 2, type: WRITE_SETTINGS },
  { name: 'field12', tag: 12, type: 'uint32' },
]);

const EMPTY_RESP = message([]);

function writeSettings(groupId: number, settings: Record<string, unknown>) {
  return { groupUin: BigInt(requireGroupId(groupId)), settings, field12: 0 };
}

function assertUint32(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`${name} 必须是 uint32`);
  }
}

export interface SetGroupSearchParams {
  groupId: number;
  /** 0 = 开启群指纹 / 关键词搜索；不传不改。 */
  noFingerOpen?: number;
  /** 0 = 开启群号搜索；不传不改。 */
  noCodeFingerOpen?: number;
}

export namespace SetGroupSearch {
  export const command = 0x89a;
  export const subCommand = 0;
  export const reqSchema = WRITE_REQ;
  export const respSchema = EMPTY_RESP;

  export type Params = SetGroupSearchParams;

  export const serialize = (p: Params): Record<string, unknown> => {
    if (p.noFingerOpen === undefined && p.noCodeFingerOpen === undefined) {
      throw new Error('至少指定一个搜索开关');
    }
    const settings: Record<string, unknown> = {};
    if (p.noFingerOpen !== undefined) {
      assertUint32(p.noFingerOpen, 'noFingerOpen');
      settings.noFingerOpen = p.noFingerOpen;
    }
    if (p.noCodeFingerOpen !== undefined) {
      assertUint32(p.noCodeFingerOpen, 'noCodeFingerOpen');
      settings.noCodeFingerOpen = p.noCodeFingerOpen;
    }
    return writeSettings(p.groupId, settings);
  };

  export const deserialize = (_body: Record<string, unknown>): void => {};

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<void> =>
    invokeOidb(nt, pid, SetGroupSearch as OidbSpec<Params, void>, params);
}

export type GroupMemberInvitePolicy =
  | 'disabled'
  | 'require_approval'
  | 'no_approval'
  | 'no_approval_under_100';

export const MEMBER_INVITE_PRIVILEGE_MASK = 0x06100000;

const POLICY_PRIVILEGE_BITS = {
  require_approval: 0,
  no_approval: 0x00100000,
  no_approval_under_100: 0x04000000,
} as const;

const MEMBER_INVITE_DISABLED_BIT = 0x80;

export function decodeMemberInviteAllowed(groupFlagExt: number | undefined): boolean | undefined {
  return groupFlagExt === undefined ? undefined : (groupFlagExt & MEMBER_INVITE_DISABLED_BIT) === 0;
}

export function mergeMemberInvitePrivilegeFlag(
  currentPrivilegeFlag: number,
  policy: GroupMemberInvitePolicy,
): number {
  assertUint32(currentPrivilegeFlag, 'currentPrivilegeFlag');
  if (policy === 'disabled') return currentPrivilegeFlag;
  const current = BigInt(currentPrivilegeFlag);
  const mask = BigInt(MEMBER_INVITE_PRIVILEGE_MASK);
  return Number((current & ~mask) | (BigInt(POLICY_PRIVILEGE_BITS[policy]) & mask));
}

export function decodeMemberInvitePolicy(
  privilegeFlag: number,
): Exclude<GroupMemberInvitePolicy, 'disabled'> {
  assertUint32(privilegeFlag, 'privilegeFlag');
  const bits = privilegeFlag & MEMBER_INVITE_PRIVILEGE_MASK;
  if ((bits & POLICY_PRIVILEGE_BITS.no_approval) !== 0) return 'no_approval';
  return bits === 0 ? 'require_approval' : 'no_approval_under_100';
}

export interface SetGroupInvitePolicyParams {
  groupId: number;
  currentPrivilegeFlag?: number;
  memberInviteAllowed?: boolean;
  policy: GroupMemberInvitePolicy;
  beforeSend?: () => void;
}

export namespace SetGroupInvitePolicy {
  export const command = 0x89a;
  export const subCommand = 8;
  export const reqSchema = WRITE_REQ;
  export const respSchema = EMPTY_RESP;

  export type Params = SetGroupInvitePolicyParams;

  export async function invoke(nt: OidbNative, pid: number, p: Params): Promise<void> {
    const disabled = p.policy === 'disabled';
    if (
      p.memberInviteAllowed === !disabled &&
      (disabled ||
        (p.currentPrivilegeFlag !== undefined &&
          decodeMemberInvitePolicy(p.currentPrivilegeFlag) === p.policy))
    )
      return;

    // Mac QQNT 的 0x89A_8 在开启邀请和切换审核档位时同包提交档位与邀请开关。
    const settings =
      p.policy === 'disabled'
        ? { allowMemberInvite: 0 }
        : {
            appPrivilegeFlag: POLICY_PRIVILEGE_BITS[p.policy],
            appPrivilegeMask: MEMBER_INVITE_PRIVILEGE_MASK,
            allowMemberInvite: 1,
          };
    p.beforeSend?.();
    try {
      await invokeOidb(
        nt,
        pid,
        {
          command,
          subCommand,
          reqSchema,
          respSchema,
          serialize: (value) => writeSettings(p.groupId, value),
          deserialize: () => {},
        },
        settings,
      );
    } catch (error) {
      if (!disabled && error instanceof Error && /OIDB error 1006\b/.test(error.message)) {
        throw new Error('QQ 拒绝修改邀请审核方式（1006），请在 QQ 群设置中修改', {
          cause: error,
        });
      }
      throw error;
    }
  }
}

export const GROUP_HISTORY_VISIBILITY_MASK = 0x4;

export function decodeGroupHistoryVisibility(groupFlagExt4: number): boolean {
  assertUint32(groupFlagExt4, 'groupFlagExt4');
  return groupFlagExt4 === 1 || (groupFlagExt4 & GROUP_HISTORY_VISIBILITY_MASK) !== 0;
}

export interface SetGroupHistoryVisibilityParams {
  groupId: number;
  visible: boolean;
}

export namespace SetGroupHistoryVisibility {
  export const command = 0x89a;
  export const subCommand = 0;
  export const reqSchema = WRITE_REQ;
  export const respSchema = EMPTY_RESP;

  export type Params = SetGroupHistoryVisibilityParams;

  export const serialize = (p: Params): Record<string, unknown> =>
    writeSettings(p.groupId, {
      groupFlagExt4: p.visible ? GROUP_HISTORY_VISIBILITY_MASK : 0,
      groupFlagExt4Mask: GROUP_HISTORY_VISIBILITY_MASK,
    });

  export const deserialize = (_body: Record<string, unknown>): void => {};

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<void> =>
    invokeOidb(nt, pid, SetGroupHistoryVisibility as OidbSpec<Params, void>, params);
}

export type GroupMemberPermission = 'upload_album' | 'temporary_session' | 'create_group';

export const GROUP_MEMBER_PERMISSION_MASKS: Record<GroupMemberPermission, number> = {
  upload_album: 0x1,
  temporary_session: 0x10000,
  create_group: 0x8000,
};

export function mergeGroupMemberPermission(
  currentPrivilegeFlag: number,
  permission: GroupMemberPermission,
  allow: boolean,
): number {
  assertUint32(currentPrivilegeFlag, 'currentPrivilegeFlag');
  const current = BigInt(currentPrivilegeFlag);
  const mask = BigInt(GROUP_MEMBER_PERMISSION_MASKS[permission]);
  return Number(allow ? current & ~mask : current | mask);
}

export function decodeGroupMemberPermissions(privilegeFlag: number): {
  allowMemberUploadAlbum: boolean;
  allowMemberTemporarySession: boolean;
  allowMemberCreateGroup: boolean;
} {
  assertUint32(privilegeFlag, 'privilegeFlag');
  return {
    allowMemberUploadAlbum: (privilegeFlag & GROUP_MEMBER_PERMISSION_MASKS.upload_album) === 0,
    allowMemberTemporarySession:
      (privilegeFlag & GROUP_MEMBER_PERMISSION_MASKS.temporary_session) === 0,
    allowMemberCreateGroup: (privilegeFlag & GROUP_MEMBER_PERMISSION_MASKS.create_group) === 0,
  };
}

export interface SetGroupMemberPermissionParams {
  groupId: number;
  currentPrivilegeFlag: number;
  permission: GroupMemberPermission;
  allow: boolean;
}

export namespace SetGroupMemberPermission {
  export const command = 0x89a;
  export const subCommand = 0;
  export const reqSchema = WRITE_REQ;
  export const respSchema = EMPTY_RESP;

  export type Params = SetGroupMemberPermissionParams;

  export const serialize = (p: Params): Record<string, unknown> =>
    writeSettings(p.groupId, {
      appPrivilegeFlag: mergeGroupMemberPermission(p.currentPrivilegeFlag, p.permission, p.allow),
      appPrivilegeMask: GROUP_MEMBER_PERMISSION_MASKS[p.permission],
    });

  export const deserialize = (_body: Record<string, unknown>): void => {};

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<void> =>
    invokeOidb(nt, pid, SetGroupMemberPermission as OidbSpec<Params, void>, params);
}
