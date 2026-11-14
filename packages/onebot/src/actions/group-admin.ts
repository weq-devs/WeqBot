/**
 * 群管理 action。
 *
 * 搬运自 SnowLuma `packages/onebot/src/actions/group-admin.ts`（2026-11-13），
 * 改成调 {@link OneBotBackend}。重命名 / 禁言 / 踢人这类**写操作**都要求后端
 * 实现对应方法，否则 action 不注册（返回 1404），避免「看起来支持、一调就崩」。
 */

import {
  optionalBool,
  ParamError,
  requiredInt,
  requiredPositiveInt,
  requiredString,
  type ActionDefinition,
} from '../action-registry';
import type { OneBotBackend } from '../backend';

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

export const GROUP_ADMIN_ACTIONS = [
  setGroupCard,
  setGroupBan,
  setGroupWholeBan,
  setGroupAdmin,
  setGroupName,
  setGroupKick,
  setGroupLeave,
  setGroupSpecialTitle,
];
