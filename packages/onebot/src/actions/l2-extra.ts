/** L2 里成本低、无需新协议的两条：群禁言列表 / 超级表情判定。 */

import {
  defineAction,
  optionalBool,
  optionalString,
  ParamError,
  requiredPositiveInt,
} from '../action-registry';
import type { JsonObject } from '../types';

function optionalNonNegativeInt(raw: JsonObject, key: string): number | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ParamError(`${key} 必须是 >= 0 的整数`);
  }
  return value;
}

const getGroupShutList = defineAction(
  {
    name: 'get_group_shut_list',
    summary: '获取群禁言列表',
    parse: (raw) => ({ groupId: requiredPositiveInt(raw, 'group_id') }),
    run: async ({ groupId }, ctx) => {
      const members = await ctx.backend.getGroupMemberList!(groupId);
      const now = Math.floor(Date.now() / 1000);
      return members
        .filter((member) => (member.shutUpTime ?? 0) > now)
        .map((member) => ({
          user_id: member.userId,
          nickname: member.nickname,
          shut_up_time: member.shutUpTime ?? 0,
        }));
    },
  },
  { available: (backend) => typeof backend.getGroupMemberList === 'function' },
);

const fetchSuperFaceId = defineAction(
  {
    name: 'fetch_super_face_id',
    summary: '判断系统表情是否使用超级表情格式',
    parse: (raw) => {
      const faceId = optionalNonNegativeInt(raw, 'face_id');
      if (faceId === undefined) throw new ParamError('face_id 不能为空');
      return { faceId, refresh: optionalBool(raw, 'refresh', false) };
    },
    run: async ({ faceId }, ctx) => {
      const faces = await ctx.backend.interactionExtra!.listSystemFaces();
      return { is_super: faces.some((face) => face.faceId === faceId && face.isSuper === true) };
    },
  },
  { available: (backend) => typeof backend.interactionExtra?.listSystemFaces === 'function' },
);

const getGroupIgnoredNotifies = defineAction(
  {
    name: 'get_group_ignored_notifies',
    summary: '获取被过滤的入群请求',
    run: async (_params: JsonObject, ctx) => {
      const requests = await ctx.backend.groupAdminExtra!.getIgnoredGroupRequests();
      return requests.map((request) => ({
        group_id: request.groupId,
        group_name: request.groupName,
        request_id: request.sequence,
        requester_uin: request.targetUin,
        requester_nick: request.targetName,
        message: request.comment,
        checked: request.checked,
        actor: request.operatorUin,
        invitor_uin: request.invitorUin,
        invitor_nick: request.invitorName,
        flag: request.flag,
      }));
    },
  },
  {
    available: (backend) => typeof backend.groupAdminExtra?.getIgnoredGroupRequests === 'function',
  },
);

const getGroupIgnoreAddRequest = defineAction(
  {
    name: 'get_group_ignore_add_request',
    summary: '获取被忽略的入群请求（NapCat 字段）',
    run: async (_params: JsonObject, ctx) => {
      const requests = await ctx.backend.groupAdminExtra!.getIgnoredGroupRequests();
      return requests.map((request) => ({
        request_id: request.sequence,
        invitor_uin: request.invitorUin,
        invitor_nick: request.invitorName,
        group_id: request.groupId,
        message: request.comment,
        group_name: request.groupName,
        checked: request.checked,
        actor: request.operatorUin,
        requester_nick: request.targetName,
      }));
    },
  },
  {
    available: (backend) => typeof backend.groupAdminExtra?.getIgnoredGroupRequests === 'function',
  },
);

const getGroupShareLink = defineAction(
  {
    name: 'get_group_share_link',
    summary: '获取群分享 / 邀请链接',
    parse: (raw) => ({
      groupId: requiredPositiveInt(raw, 'group_id'),
      needShortUrl: optionalBool(raw, 'need_short_url', true),
      srcId: optionalNonNegativeInt(raw, 'src_id') ?? 73,
      additionalParam: optionalString(raw, 'additional_param') ?? '',
    }),
    run: async ({ groupId, needShortUrl, srcId, additionalParam }, ctx) => ({
      url: await ctx.backend.contactsExtra!.getGroupShareLink({
        groupId,
        needShortUrl,
        srcId,
        additionalParam,
      }),
    }),
  },
  { available: (backend) => typeof backend.contactsExtra?.getGroupShareLink === 'function' },
);

const getRkeyServer = defineAction(
  {
    name: 'get_rkey_server',
    summary: '获取下载 rkey',
    run: async (_params: JsonObject, ctx) => {
      const entries = await ctx.backend.rkey!.getDownloadRkeys();
      const pick = (type: number) => entries.find((entry) => entry.type === type);
      const priv = pick(10);
      const group = pick(20);
      if (!priv?.rkey && !group?.rkey) {
        throw new Error('no download rkey available');
      }
      const ttls = [priv?.ttlSeconds, group?.ttlSeconds].filter(
        (ttl): ttl is number => typeof ttl === 'number' && ttl > 0,
      );
      const minTtl = ttls.length ? Math.min(...ttls) : 0;
      const data: Record<string, unknown> = {
        expired_time: Math.floor(Date.now() / 1000) + minTtl,
        name: 'WeqBot',
      };
      if (priv?.rkey) data.private_rkey = priv.rkey;
      if (group?.rkey) data.group_rkey = group.rkey;
      return data;
    },
  },
  { available: (backend) => typeof backend.rkey?.getDownloadRkeys === 'function' },
);

const getMiniAppArk = defineAction(
  {
    name: 'get_mini_app_ark',
    summary: '获取小程序分享卡片',
    parse: (raw) => {
      const type = optionalString(raw, 'type') || 'bili';
      if (type !== 'bili' && type !== 'weibo') {
        throw new ParamError('type 只支持 bili / weibo');
      }
      return {
        type,
        title: optionalString(raw, 'title') ?? '',
        desc: optionalString(raw, 'desc') ?? '',
        picUrl: optionalString(raw, 'picUrl') ?? optionalString(raw, 'pic_url') ?? '',
        jumpUrl: optionalString(raw, 'jumpUrl') ?? optionalString(raw, 'jump_url') ?? '',
      };
    },
    run: async (params, ctx) => ctx.backend.misc!.getMiniAppArk(params),
  },
  { available: (backend) => typeof backend.misc?.getMiniAppArk === 'function' },
);

const botExit = defineAction(
  {
    name: 'bot_exit',
    summary: '优雅下线 bot（不退出进程）',
    run: async (_params: JsonObject, ctx) => {
      // 先让 action 响应发回去，再 teardown；不 process.exit。
      setTimeout(() => {
        void ctx.backend.botControl!.shutdown('bot-exit').catch(() => {});
      }, 50);
      return null;
    },
  },
  { available: (backend) => typeof backend.botControl?.shutdown === 'function' },
);

export const L2_EXTRA_ACTIONS = [
  getGroupShutList,
  fetchSuperFaceId,
  getGroupIgnoredNotifies,
  getGroupIgnoreAddRequest,
  getGroupShareLink,
  getRkeyServer,
  getMiniAppArk,
  botExit,
];
