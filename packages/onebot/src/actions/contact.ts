/**
 * 名单 / 资料类 action。
 *
 * 搬运自 SnowLuma `packages/onebot/src/actions/{friend,group-info,info}.ts`
 * （2026-11-13），改成调 {@link OneBotBackend}。后端没实现的 action 不注册，
 * 调用时返回 1404 —— 这样协议能力涨一点，OneBot 面自动跟上。
 */

import { ParamError, requiredPositiveInt, type ActionDefinition } from '../action-registry';
import type { OneBotBackend } from '../backend';

type Requires = Array<keyof OneBotBackend>;

function define<P, R>(
  definition: ActionDefinition<P, R>,
  requires: Requires,
): { definition: ActionDefinition<never, never>; requires: Requires } {
  return { definition: definition as ActionDefinition<never, never>, requires };
}

const getLoginInfo = define(
  {
    name: 'get_login_info',
    summary: '获取登录号信息',
    run: async (_params, ctx) => {
      const info = await ctx.backend.getLoginInfo();
      return { user_id: info.userId, nickname: info.nickname };
    },
  },
  ['getLoginInfo'],
);

const getFriendList = define(
  {
    name: 'get_friend_list',
    summary: '获取好友列表',
    run: async (_params, ctx) => {
      if (!ctx.backend.getFriendList) return [];
      const friends = await ctx.backend.getFriendList();
      return friends.map((friend) => ({
        user_id: friend.userId,
        nickname: friend.nickname,
        remark: friend.remark,
      }));
    },
  },
  ['getFriendList'],
);

const getGroupList = define(
  {
    name: 'get_group_list',
    summary: '获取群列表',
    run: async (_params, ctx) => {
      if (!ctx.backend.getGroupList) return [];
      const groups = await ctx.backend.getGroupList();
      return groups.map((group) => ({
        group_id: group.groupId,
        group_name: group.groupName,
        member_count: group.memberCount,
        max_member_count: group.maxMemberCount,
      }));
    },
  },
  ['getGroupList'],
);

const getGroupInfo = define(
  {
    name: 'get_group_info',
    summary: '获取群信息',
    parse: (raw) => ({ groupId: requiredPositiveInt(raw, 'group_id') }),
    run: async ({ groupId }: { groupId: number }, ctx) => {
      if (!ctx.backend.getGroupInfo) throw new ParamError('后端不支持 get_group_info');
      const group = await ctx.backend.getGroupInfo(groupId);
      return {
        group_id: group.groupId,
        group_name: group.groupName,
        member_count: group.memberCount,
        max_member_count: group.maxMemberCount,
      };
    },
  },
  ['getGroupInfo'],
);

function mapMember(member: {
  groupId: number;
  userId: number;
  nickname: string;
  card: string;
  sex: 'male' | 'female' | 'unknown';
  age: number;
  area: string;
  joinTime: number;
  lastSentTime: number;
  level: string;
  role: 'owner' | 'admin' | 'member';
  title: string;
}) {
  return {
    group_id: member.groupId,
    user_id: member.userId,
    nickname: member.nickname,
    card: member.card,
    sex: member.sex,
    age: member.age,
    area: member.area,
    join_time: member.joinTime,
    last_sent_time: member.lastSentTime,
    level: member.level,
    role: member.role,
    title: member.title,
    unfriendly: false,
    card_changeable: false,
  };
}

const getGroupMemberList = define(
  {
    name: 'get_group_member_list',
    summary: '获取群成员列表',
    parse: (raw) => ({ groupId: requiredPositiveInt(raw, 'group_id') }),
    run: async ({ groupId }: { groupId: number }, ctx) => {
      if (!ctx.backend.getGroupMemberList) return [];
      const members = await ctx.backend.getGroupMemberList(groupId);
      return members.map(mapMember);
    },
  },
  ['getGroupMemberList'],
);

const getGroupMemberInfo = define(
  {
    name: 'get_group_member_info',
    summary: '获取群成员信息',
    parse: (raw) => ({
      groupId: requiredPositiveInt(raw, 'group_id'),
      userId: requiredPositiveInt(raw, 'user_id'),
    }),
    run: async ({ groupId, userId }: { groupId: number; userId: number }, ctx) => {
      if (!ctx.backend.getGroupMemberInfo) throw new ParamError('后端不支持 get_group_member_info');
      return mapMember(await ctx.backend.getGroupMemberInfo(groupId, userId));
    },
  },
  ['getGroupMemberInfo'],
);

const getStrangerInfo = define(
  {
    name: 'get_stranger_info',
    summary: '获取陌生人信息',
    parse: (raw) => ({ userId: requiredPositiveInt(raw, 'user_id') }),
    run: async ({ userId }: { userId: number }, ctx) => {
      if (!ctx.backend.getStrangerInfo) throw new ParamError('后端不支持 get_stranger_info');
      const info = await ctx.backend.getStrangerInfo(userId);
      return { user_id: info.userId, nickname: info.nickname, sex: info.sex, age: info.age };
    },
  },
  ['getStrangerInfo'],
);

export const CONTACT_ACTIONS = [
  getLoginInfo,
  getFriendList,
  getGroupList,
  getGroupInfo,
  getGroupMemberList,
  getGroupMemberInfo,
  getStrangerInfo,
];
