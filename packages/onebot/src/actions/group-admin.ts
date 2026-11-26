/**
 * 群管理 action。
 *
 * 搬运自 SnowLuma `packages/onebot/src/actions/group-admin.ts`（2026-11-13），
 * 改成调 {@link OneBotBackend}。重命名 / 禁言 / 踢人这类**写操作**都要求后端
 * 实现对应方法，否则 action 不注册（返回 1404），避免「看起来支持、一调就崩」。
 */

import {
  defineAction,
  optionalBool,
  optionalString,
  ParamError,
  requiredInt,
  requiredPositiveInt,
  requiredString,
  type ActionContext,
  type ActionDefinition,
} from '../action-registry';
import type { GroupMemberInvitePolicy, OneBotBackend } from '../backend';
import { decodeInlineMedia, isInlineMediaSource } from '../segments';
import type { JsonObject } from '../types';

type Requires = Array<keyof OneBotBackend>;

/**
 * `duration` 是「剩余秒数」，允许 `-1`（永久）。
 *
 * 不能复用 `optionalPositiveInt`：它把负数当非法值，而这里 -1 是合法语义。
 */
function parseDuration(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isSafeInteger(value) || value < -1)
    throw new ParamError('duration 必须 >= -1 的整数');
  return value < 0 ? undefined : value;
}

function define<P, R>(
  definition: ActionDefinition<P, R>,
  requires: Requires,
): { definition: ActionDefinition<never, never>; requires: Requires } {
  return { definition: definition as ActionDefinition<never, never>, requires };
}

const setGroupCard = define(
  {
    name: 'set_group_card',
    summary: '设置群名片',
    parse: (raw) => ({
      groupId: requiredPositiveInt(raw, 'group_id'),
      userId: requiredPositiveInt(raw, 'user_id'),
      card: requiredString(raw, 'card'),
    }),
    run: async ({ groupId, userId, card }, ctx) => {
      await ctx.backend.setGroupCard!(groupId, userId, card);
      return null;
    },
  },
  ['setGroupCard'],
);

const setGroupBan = define(
  {
    name: 'set_group_ban',
    summary: '群禁言',
    parse: (raw) => ({
      groupId: requiredPositiveInt(raw, 'group_id'),
      userId: requiredPositiveInt(raw, 'user_id'),
      duration: requiredInt(raw, 'duration'),
    }),
    run: async ({ groupId, userId, duration }, ctx) => {
      await ctx.backend.setGroupBan!(groupId, userId, duration);
      return null;
    },
  },
  ['setGroupBan'],
);

const setGroupWholeBan = define(
  {
    name: 'set_group_whole_ban',
    summary: '全员禁言',
    parse: (raw) => ({
      groupId: requiredPositiveInt(raw, 'group_id'),
      enable: optionalBool(raw, 'enable', true),
    }),
    run: async ({ groupId, enable }, ctx) => {
      await ctx.backend.setGroupWholeBan!(groupId, enable);
      return null;
    },
  },
  ['setGroupWholeBan'],
);

const setGroupAdmin = define(
  {
    name: 'set_group_admin',
    summary: '设置群管理员',
    parse: (raw) => ({
      groupId: requiredPositiveInt(raw, 'group_id'),
      userId: requiredPositiveInt(raw, 'user_id'),
      enable: optionalBool(raw, 'enable', true),
    }),
    run: async ({ groupId, userId, enable }, ctx) => {
      await ctx.backend.setGroupAdmin!(groupId, userId, enable);
      return null;
    },
  },
  ['setGroupAdmin'],
);

const setGroupName = define(
  {
    name: 'set_group_name',
    summary: '设置群名',
    parse: (raw) => ({
      groupId: requiredPositiveInt(raw, 'group_id'),
      name: requiredString(raw, 'group_name'),
    }),
    run: async ({ groupId, name }, ctx) => {
      await ctx.backend.setGroupName!(groupId, name);
      return null;
    },
  },
  ['setGroupName'],
);

const setGroupKick = define(
  {
    name: 'set_group_kick',
    summary: '踢出群成员',
    parse: (raw) => ({
      groupId: requiredPositiveInt(raw, 'group_id'),
      userId: requiredPositiveInt(raw, 'user_id'),
      reject: optionalBool(raw, 'reject_add_request'),
    }),
    run: async ({ groupId, userId, reject }, ctx) => {
      await ctx.backend.setGroupKick!(groupId, userId, reject);
      return null;
    },
  },
  ['setGroupKick'],
);

const setGroupLeave = define(
  {
    name: 'set_group_leave',
    summary: '退出群',
    parse: (raw) => ({
      groupId: requiredPositiveInt(raw, 'group_id'),
      dissolve: optionalBool(raw, 'is_dismiss'),
    }),
    run: async ({ groupId, dissolve }, ctx) => {
      await ctx.backend.setGroupLeave!(groupId, dissolve);
      return null;
    },
  },
  ['setGroupLeave'],
);

const setGroupSpecialTitle = define(
  {
    name: 'set_group_special_title',
    summary: '设置群头衔',
    parse: (raw) => ({
      groupId: requiredPositiveInt(raw, 'group_id'),
      userId: requiredPositiveInt(raw, 'user_id'),
      title: typeof raw.special_title === 'string' ? raw.special_title : '',
      // OneBot 的 `duration` 是秒，`-1`（缺省）在协议层表示永久。
      duration: parseDuration(raw.duration),
    }),
    run: async ({ groupId, userId, title, duration }, ctx) => {
      await ctx.backend.setGroupSpecialTitle!(groupId, userId, title, duration);
      return null;
    },
  },
  ['setGroupSpecialTitle'],
);

/** `message_id` → 群号 + seq + random（群精华要随机值定位消息）。 */
function resolveGroupMeta(ctx: ActionContext, messageId: number) {
  const meta = ctx.resolveMessageMeta(messageId);
  if (!meta) throw new Error(`未知的 message_id：${messageId}（只认识本进程收到 / 发出的消息）`);
  if (!meta.isGroup) throw new ParamError('这条 action 只支持群消息');
  if (meta.random === undefined) throw new Error('这条消息缺少 random，无法定位精华消息');
  return { groupId: meta.targetId, sequence: meta.sequence, random: meta.random };
}

const setEssenceMsg = defineAction(
  {
    name: 'set_essence_msg',
    summary: '设为群精华消息',
    parse: (raw) => ({ messageId: requiredPositiveInt(raw, 'message_id') }),
    run: async ({ messageId }, ctx) => {
      const meta = resolveGroupMeta(ctx, messageId);
      await ctx.backend.groupEssence!.setEssence({ ...meta, enable: true });
      return null;
    },
  },
  { available: (backend) => typeof backend.groupEssence?.setEssence === 'function' },
);

const deleteEssenceMsg = defineAction(
  {
    name: 'delete_essence_msg',
    summary: '移除群精华消息',
    parse: (raw) => ({ messageId: requiredPositiveInt(raw, 'message_id') }),
    run: async ({ messageId }, ctx) => {
      const meta = resolveGroupMeta(ctx, messageId);
      await ctx.backend.groupEssence!.setEssence({ ...meta, enable: false });
      return null;
    },
  },
  { available: (backend) => typeof backend.groupEssence?.setEssence === 'function' },
);

const setGroupRemark = defineAction(
  {
    name: 'set_group_remark',
    summary: '设置群备注',
    parse: (raw) => ({
      groupId: requiredPositiveInt(raw, 'group_id'),
      remark: requiredString(raw, 'remark'),
    }),
    run: async ({ groupId, remark }, ctx) => {
      await ctx.backend.groupAdminExtra!.setGroupRemark(groupId, remark);
      return null;
    },
  },
  { available: (backend) => typeof backend.groupAdminExtra?.setGroupRemark === 'function' },
);

function groupInfoDefinition(name: string, summary: string) {
  return defineAction(
    {
      name,
      summary,
      parse: (raw) => ({ groupId: requiredPositiveInt(raw, 'group_id') }),
      run: async ({ groupId }, ctx) => {
        const group = await ctx.backend.groupAdminExtra!.getGroupInfoEx(groupId);
        return {
          group_id: group.groupId,
          group_name: group.groupName,
          group_remark: group.groupRemark,
          member_count: group.memberCount,
          max_member_count: group.maxMemberCount,
          group_create_time: group.createTime,
          group_level: group.level,
          group_memo: group.memo,
          group_description: group.description,
          group_all_shut: group.allShut ? -1 : 0,
        };
      },
    },
    { available: (backend) => typeof backend.groupAdminExtra?.getGroupInfoEx === 'function' },
  );
}

// SnowLuma 里两条 action 指向同一个实现，照抄。
const groupInfoEx = groupInfoDefinition('get_group_info_ex', '获取群信息（扩展）');
const groupDetailInfo = groupInfoDefinition('get_group_detail_info', '获取群详细信息');

/** 三态布尔：缺省返回 `undefined`（`optionalBool` 会把缺省变成 false）。 */
function optionalBoolean(raw: JsonObject, key: string): boolean | undefined {
  if (raw[key] === undefined || raw[key] === null) return undefined;
  return optionalBool(raw, key);
}

/** 非负整数；用于 add_type / group_class / 机器人开关。 */
function optionalNonNegativeInt(raw: JsonObject, key: string): number | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ParamError(`${key} 必须是 >= 0 的整数`);
  }
  return value;
}

function requiredNonNegativeInt(raw: JsonObject, key: string): number {
  const value = optionalNonNegativeInt(raw, key);
  if (value === undefined) throw new ParamError(`${key} 不能为空`);
  return value;
}

/** `user_id` 既接受单个 QQ 号，也接受数组（SnowLuma 的 `f.array(f.memberId())`）。 */
function requiredMemberIds(raw: JsonObject): number[] {
  const value = raw.user_id;
  const list = Array.isArray(value) ? value : value === undefined ? [] : [value];
  if (list.length === 0) throw new ParamError('user_id 不能为空');
  return list.map((item) => {
    const id =
      typeof item === 'number'
        ? item
        : typeof item === 'string' && /^\d+$/.test(item.trim())
          ? Number(item.trim())
          : Number.NaN;
    if (!Number.isSafeInteger(id) || id <= 0)
      throw new ParamError('user_id 必须是正整数或正整数数组');
    return id;
  });
}

const setGroupKickMembers = defineAction(
  {
    name: 'set_group_kick_members',
    summary: '批量踢出群成员',
    parse: (raw) => ({
      groupId: requiredPositiveInt(raw, 'group_id'),
      userIds: requiredMemberIds(raw),
      reject: optionalBool(raw, 'reject_add_request', false),
    }),
    run: async ({ groupId, userIds, reject }, ctx) => {
      await ctx.backend.groupAdminExtra!.kickMembers(groupId, userIds, reject);
      return null;
    },
  },
  { available: (backend) => typeof backend.groupAdminExtra?.kickMembers === 'function' },
);

const setGroupAddOption = defineAction(
  {
    name: 'set_group_add_option',
    summary: '设置加群选项',
    parse: (raw) => ({
      groupId: requiredPositiveInt(raw, 'group_id'),
      addType: optionalNonNegativeInt(raw, 'add_type') ?? 0,
      groupQuestion: optionalString(raw, 'group_question'),
      groupAnswer: optionalString(raw, 'group_answer'),
    }),
    run: async (params, ctx) => {
      await ctx.backend.groupAdminExtra!.setAddOption(params);
      return null;
    },
  },
  { available: (backend) => typeof backend.groupAdminExtra?.setAddOption === 'function' },
);

const getGroupTags = defineAction(
  {
    name: 'get_group_tags',
    summary: '读取某个群分类下的资料标签',
    parse: (raw) => ({ groupClass: requiredNonNegativeInt(raw, 'group_class') }),
    run: async ({ groupClass }, ctx) => ({
      tags: await ctx.backend.groupAdminExtra!.listCategoryTags(groupClass),
    }),
  },
  { available: (backend) => typeof backend.groupAdminExtra?.listCategoryTags === 'function' },
);

function categoryTagChange(name: 'add_group_tag' | 'delete_group_tag', summary: string) {
  return defineAction(
    {
      name,
      summary,
      parse: (raw) => {
        const tag = requiredString(raw, 'name').trim();
        if (!tag) throw new ParamError('name 不能为空');
        return { groupClass: requiredNonNegativeInt(raw, 'group_class'), name: tag };
      },
      run: async ({ groupClass, name: tag }, ctx) => {
        if (name === 'add_group_tag') {
          await ctx.backend.groupAdminExtra!.addCategoryTag(groupClass, tag);
        } else {
          await ctx.backend.groupAdminExtra!.removeCategoryTag(groupClass, tag);
        }
        return null;
      },
    },
    {
      available: (backend) =>
        typeof backend.groupAdminExtra?.[
          name === 'add_group_tag' ? 'addCategoryTag' : 'removeCategoryTag'
        ] === 'function',
    },
  );
}

const addGroupTag = categoryTagChange('add_group_tag', '添加群资料标签');
const deleteGroupTag = categoryTagChange('delete_group_tag', '删除群资料标签');

const getGroupAdminPermissions = defineAction(
  {
    name: 'get_group_admin_permissions',
    summary: '读取指定管理员权限',
    parse: (raw) => ({
      groupId: requiredPositiveInt(raw, 'group_id'),
      userId: requiredPositiveInt(raw, 'user_id'),
    }),
    run: async ({ groupId, userId }, ctx) => {
      const snapshot = await ctx.backend.groupAdminExtra!.getAdminPermissions(groupId, userId);
      return { group_id: groupId, user_id: userId, ...snapshot };
    },
  },
  { available: (backend) => typeof backend.groupAdminExtra?.getAdminPermissions === 'function' },
);

const KICK_MEMBER_PER_DAY_CHOICES = [0, 5, 10, 20, 50, 100, 200];

const setGroupAdminPermissions = defineAction(
  {
    name: 'set_group_admin_permissions',
    summary: '设置指定管理员的撤回 / 踢人权限',
    parse: (raw) => {
      const recall = optionalBoolean(raw, 'recall_member_message');
      const kick = optionalBoolean(raw, 'kick_member');
      const perDay = optionalNonNegativeInt(raw, 'kick_member_per_day');
      if (recall === undefined && kick === undefined) {
        throw new ParamError('recall_member_message 与 kick_member 至少要传一个');
      }
      if (
        kick === true &&
        (perDay === undefined || !KICK_MEMBER_PER_DAY_CHOICES.includes(perDay))
      ) {
        throw new ParamError(
          `开启踢人需要 kick_member_per_day：${KICK_MEMBER_PER_DAY_CHOICES.join(' / ')}`,
        );
      }
      if (kick !== true && perDay !== undefined) {
        throw new ParamError('kick_member_per_day 只在 kick_member=true 时有意义');
      }
      return {
        groupId: requiredPositiveInt(raw, 'group_id'),
        userId: requiredPositiveInt(raw, 'user_id'),
        recallMemberMessage: recall,
        kickMember: kick,
        kickMemberPerDay: perDay,
      };
    },
    run: async (params, ctx) => {
      await ctx.backend.groupAdminExtra!.setAdminPermissions!(params);
      return null;
    },
  },
  { available: (backend) => typeof backend.groupAdminExtra?.setAdminPermissions === 'function' },
);

const setGroupAdminReceiveVerify = defineAction(
  {
    name: 'set_group_admin_receive_verify',
    summary: '设置指定管理员是否接收加群验证消息',
    parse: (raw) => ({
      groupId: requiredPositiveInt(raw, 'group_id'),
      userId: requiredPositiveInt(raw, 'user_id'),
      enable: (() => {
        const value = optionalBoolean(raw, 'enable');
        if (value === undefined) throw new ParamError('enable 不能为空');
        return value;
      })(),
    }),
    run: async ({ groupId, userId, enable }, ctx) => {
      await ctx.backend.groupAdminExtra!.setAdminReceiveVerify(groupId, userId, enable);
      return null;
    },
  },
  { available: (backend) => typeof backend.groupAdminExtra?.setAdminReceiveVerify === 'function' },
);

const setGroupRobotAddOption = defineAction(
  {
    name: 'set_group_robot_add_option',
    summary: '设置群机器人加群选项',
    parse: (raw) => {
      const robotMemberSwitch = optionalNonNegativeInt(raw, 'robot_member_switch');
      const robotMemberExamine = optionalNonNegativeInt(raw, 'robot_member_examine');
      if (robotMemberSwitch === undefined && robotMemberExamine === undefined) {
        throw new ParamError('robot_member_switch 与 robot_member_examine 至少要传一个');
      }
      return {
        groupId: requiredPositiveInt(raw, 'group_id'),
        robotMemberSwitch,
        robotMemberExamine,
      };
    },
    run: async (params, ctx) => {
      await ctx.backend.groupAdminExtra!.setRobotAddOption(params);
      return null;
    },
  },
  { available: (backend) => typeof backend.groupAdminExtra?.setRobotAddOption === 'function' },
);

const setGroupPortrait = defineAction(
  {
    name: 'set_group_portrait',
    summary: '设置群头像',
    parse: (raw) => {
      const file = requiredString(raw, 'file').trim();
      if (!file) throw new ParamError('file 不能为空');
      const inline = isInlineMediaSource(file) ? decodeInlineMedia(file) : undefined;
      if (isInlineMediaSource(file) && !inline) throw new ParamError('file 不是合法的 base64 数据');
      return { groupId: requiredPositiveInt(raw, 'group_id'), file, inline };
    },
    run: async ({ groupId, file, inline }, ctx) => {
      await ctx.backend.groupAdminExtra!.setGroupAvatar(groupId, inline ?? file);
      return null;
    },
  },
  { available: (backend) => typeof backend.groupAdminExtra?.setGroupAvatar === 'function' },
);

const setGroupSearch = defineAction(
  {
    name: 'set_group_search',
    summary: '设置群被搜索方式',
    parse: (raw) => {
      const noFingerOpen = optionalNonNegativeInt(raw, 'no_finger_open');
      const noCodeFingerOpen = optionalNonNegativeInt(raw, 'no_code_finger_open');
      if (noFingerOpen === undefined && noCodeFingerOpen === undefined) {
        throw new ParamError('no_finger_open 与 no_code_finger_open 至少要传一个');
      }
      return {
        groupId: requiredPositiveInt(raw, 'group_id'),
        noFingerOpen,
        noCodeFingerOpen,
      };
    },
    run: async (params, ctx) => {
      await ctx.backend.groupAdminExtra!.setGroupSearch(params);
      return null;
    },
  },
  { available: (backend) => typeof backend.groupAdminExtra?.setGroupSearch === 'function' },
);

const INVITE_POLICIES: GroupMemberInvitePolicy[] = [
  'disabled',
  'require_approval',
  'no_approval',
  'no_approval_under_100',
];

const setGroupMemberInvitePolicy = defineAction(
  {
    name: 'set_group_member_invite_policy',
    summary: '设置群成员邀请策略',
    parse: (raw) => {
      const policy = requiredString(raw, 'policy');
      if (!INVITE_POLICIES.includes(policy as GroupMemberInvitePolicy)) {
        throw new ParamError(`policy 必须是 ${INVITE_POLICIES.join(' / ')}`);
      }
      return {
        groupId: requiredPositiveInt(raw, 'group_id'),
        policy: policy as GroupMemberInvitePolicy,
      };
    },
    run: async ({ groupId, policy }, ctx) => {
      await ctx.backend.groupAdminExtra!.setMemberInvitePolicy(groupId, policy);
      return null;
    },
  },
  {
    available: (backend) => typeof backend.groupAdminExtra?.setMemberInvitePolicy === 'function',
  },
);

const setGroupNewMemberHistoryVisibility = defineAction(
  {
    name: 'set_group_new_member_history_visibility',
    summary: '设置新成员是否可查看历史消息',
    parse: (raw) => {
      const visible = optionalBoolean(raw, 'visible');
      if (visible === undefined) throw new ParamError('visible 不能为空');
      return { groupId: requiredPositiveInt(raw, 'group_id'), visible };
    },
    run: async ({ groupId, visible }, ctx) => {
      await ctx.backend.groupAdminExtra!.setNewMemberHistoryVisibility(groupId, visible);
      return null;
    },
  },
  {
    available: (backend) =>
      typeof backend.groupAdminExtra?.setNewMemberHistoryVisibility === 'function',
  },
);

const setGroupMemberPermissions = defineAction(
  {
    name: 'set_group_member_permissions',
    summary: '设置群成员权限（仅群主可改）',
    parse: (raw) => {
      const patch = {
        allowMemberUploadAlbum: optionalBoolean(raw, 'allow_member_upload_album'),
        allowMemberTemporarySession: optionalBoolean(raw, 'allow_member_temporary_session'),
        allowMemberCreateGroup: optionalBoolean(raw, 'allow_member_create_group'),
      };
      if (Object.values(patch).every((value) => value === undefined)) {
        throw new ParamError('至少传入一个成员权限字段');
      }
      return { groupId: requiredPositiveInt(raw, 'group_id'), patch };
    },
    run: async ({ groupId, patch }, ctx) => {
      await ctx.backend.groupAdminExtra!.setMemberPermissions(groupId, patch);
      return null;
    },
  },
  { available: (backend) => typeof backend.groupAdminExtra?.setMemberPermissions === 'function' },
);

const getGroupAdminSettings = defineAction(
  {
    name: 'get_group_admin_settings',
    summary: '获取群管理设置的当前值',
    parse: (raw) => ({ groupId: requiredPositiveInt(raw, 'group_id') }),
    run: async ({ groupId }, ctx) => ctx.backend.groupAdminExtra!.getGroupAdminSettings(groupId),
  },
  { available: (backend) => typeof backend.groupAdminExtra?.getGroupAdminSettings === 'function' },
);

const getGroupSystemMsg = defineAction(
  {
    name: 'get_group_system_msg',
    summary: '获取群系统消息',
    parse: (raw) => {
      const groupId =
        raw.group_id === undefined || raw.group_id === null
          ? undefined
          : requiredPositiveInt(raw, 'group_id');
      const count = optionalNonNegativeInt(raw, 'count') ?? 50;
      if (count < 1 || count > 100) throw new ParamError('count 必须在 1-100 之间');
      return {
        groupId,
        onlyPending: optionalBool(raw, 'only_pending', false),
        count,
      };
    },
    run: async (params, ctx) => ctx.backend.groupAdminExtra!.getGroupSystemMessages(params),
  },
  { available: (backend) => typeof backend.groupAdminExtra?.getGroupSystemMessages === 'function' },
);

export const GROUP_ADMIN_ACTIONS = [
  setGroupCard,
  setGroupBan,
  setGroupWholeBan,
  setGroupAdmin,
  setGroupName,
  setGroupKick,
  setGroupLeave,
  setGroupSpecialTitle,
  setEssenceMsg,
  deleteEssenceMsg,
  setGroupRemark,
  groupInfoEx,
  groupDetailInfo,
  setGroupKickMembers,
  setGroupAddOption,
  getGroupTags,
  addGroupTag,
  deleteGroupTag,
  getGroupAdminPermissions,
  setGroupAdminPermissions,
  setGroupAdminReceiveVerify,
  setGroupRobotAddOption,
  setGroupPortrait,
  getGroupSystemMsg,
  setGroupSearch,
  setGroupMemberInvitePolicy,
  setGroupNewMemberHistoryVisibility,
  setGroupMemberPermissions,
  getGroupAdminSettings,
];
