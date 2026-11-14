/**
 * 扩展 action（P8.2）：A 类里「协议已有、只差封装」的那批。
 *
 * 命名 / 参数对齐 SnowLuma。历史消息与合并转发**故意还不在这里** —— 它们需要
 * 把 wire 消息转成 OneBot 消息对象，属于适配层的下一批（见 TODO §12.8 P8.2 的
 * 未勾选项），先用 1404 暴露出来而不是返回半成品。
 */

import {
  defineAction,
  optionalBool,
  optionalPositiveInt,
  optionalString,
  ParamError,
  requiredPositiveInt,
  requiredString,
  type ActionContext,
} from '../action-registry';
import type { SystemFaceInfo } from '../backend';
import type { JsonObject } from '../types';

function emojiIds(raw: JsonObject, key: string): string[] {
  const value = raw[key];
  if (typeof value === 'string') return value ? [value] : [];
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value as string[];
  }
  throw new ParamError(`${key} 必须是字符串数组`);
}

function requiredWords(raw: JsonObject, key: string): string[] {
  const value = raw[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new ParamError(`${key} 必须是字符串数组`);
  }
  return value as string[];
}

/** `message_id` → 群号 + 群消息 seq。 */
function resolveGroupAnchor(ctx: ActionContext, messageId: number) {
  const meta = ctx.resolveMessageMeta(messageId);
  if (!meta) throw new Error(`未知的 message_id：${messageId}（只认识本进程收到 / 发出的消息）`);
  if (!meta.isGroup) throw new Error('这条 action 只支持群消息');
  return { groupId: meta.targetId, sequence: meta.sequence };
}

const face = (item: SystemFaceInfo) => ({
  face_id: item.faceId,
  name: item.name,
  is_super: item.isSuper === true,
  ...(item.emojiId ? { emoji_id: item.emojiId } : {}),
  ...(item.describe ? { describe: item.describe } : {}),
});

const customFaceActions = [
  defineAction(
    {
      name: 'fetch_custom_face',
      summary: '获取收藏表情列表',
      run: async (_params: JsonObject, ctx) => ({
        emoji_ids: await ctx.backend.customFace!.listCustomFaces(),
      }),
    },
    { available: (backend) => typeof backend.customFace?.listCustomFaces === 'function' },
  ),
  defineAction(
    {
      name: 'fetch_custom_face_detail',
      summary: '获取收藏表情详情（备注）',
      parse: (raw) => ({ emojiIds: emojiIds(raw, 'emoji_ids') }),
      run: async ({ emojiIds: ids }, ctx) => {
        const detail = await ctx.backend.customFace!.getCustomFaceDetail(ids);
        return {
          emojis: detail.map((item) => ({
            emoji_id: item.emojiId,
            desc: item.desc ?? '',
          })),
        };
      },
    },
    { available: (backend) => typeof backend.customFace?.getCustomFaceDetail === 'function' },
  ),
  defineAction(
    {
      name: 'modify_custom_face',
      summary: '修改收藏表情备注',
      parse: (raw) => ({
        emojiId: requiredString(raw, 'emoji_id'),
        desc: optionalString(raw, 'desc') ?? '',
      }),
      run: async ({ emojiId, desc }, ctx) => {
        await ctx.backend.customFace!.modifyCustomFace(emojiId, desc);
        return null;
      },
    },
    { available: (backend) => typeof backend.customFace?.modifyCustomFace === 'function' },
  ),
  defineAction(
    {
      name: 'move_custom_face_to_front',
      summary: '把收藏表情移到最前',
      parse: (raw) => ({ emojiId: requiredString(raw, 'emoji_id') }),
      run: async ({ emojiId }, ctx) => {
        await ctx.backend.customFace!.moveCustomFaceToFront(emojiId);
        return null;
      },
    },
    { available: (backend) => typeof backend.customFace?.moveCustomFaceToFront === 'function' },
  ),
  defineAction(
    {
      name: 'delete_custom_face',
      summary: '删除收藏表情',
      parse: (raw) => ({ emojiIds: emojiIds(raw, 'emoji_ids') }),
      run: async ({ emojiIds: ids }, ctx) => {
        await ctx.backend.customFace!.deleteCustomFace(ids);
        return null;
      },
    },
    { available: (backend) => typeof backend.customFace?.deleteCustomFace === 'function' },
  ),
];

const systemFaceActions = [
  defineAction(
    {
      name: 'fetch_sys_faces',
      summary: '获取系统表情目录',
      run: async (_params: JsonObject, ctx) => {
        const faces = await ctx.backend.interactionExtra!.listSystemFaces();
        return { faces: faces.map(face) };
      },
    },
    { available: (backend) => typeof backend.interactionExtra?.listSystemFaces === 'function' },
  ),
  defineAction(
    {
      name: 'search_sys_faces',
      summary: '按关键字搜索系统表情',
      parse: (raw) => ({ keyword: requiredString(raw, 'keyword') }),
      run: async ({ keyword }, ctx) => {
        const faces = await ctx.backend.interactionExtra!.listSystemFaces();
        const needle = keyword.toLowerCase();
        return {
          faces: faces
            .filter(
              (item) =>
                item.name.toLowerCase().includes(needle) ||
                String(item.faceId) === keyword ||
                (item.emojiId ?? '').toLowerCase().includes(needle),
            )
            .map(face),
        };
      },
    },
    { available: (backend) => typeof backend.interactionExtra?.listSystemFaces === 'function' },
  ),
  defineAction(
    {
      name: 'fetch_face_entity',
      summary: '按 id 查询单个系统表情',
      parse: (raw) => ({ faceId: requiredPositiveInt(raw, 'face_id') }),
      run: async ({ faceId }, ctx) => {
        const item = await ctx.backend.interactionExtra!.getSystemFace(faceId);
        return item ? face(item) : null;
      },
    },
    { available: (backend) => typeof backend.interactionExtra?.getSystemFace === 'function' },
  ),
];

const emojiLikeActions = [
  'get_emoji_likes',
  'get_msg_emoji_likes',
  'fetch_emoji_like',
  'fetch_emoji_likes',
].map((name) =>
  defineAction(
    {
      name,
      summary: '获取消息的表情回应列表',
      parse: (raw) => ({
        messageId: requiredPositiveInt(raw, 'message_id'),
        emojiId: requiredString(raw, 'emoji_id'),
        count: optionalPositiveInt(raw, 'count'),
        cookie: optionalString(raw, 'cookie'),
      }),
      run: async ({ messageId, emojiId, count, cookie }, ctx) => {
        const { groupId, sequence } = resolveGroupAnchor(ctx, messageId);
        return ctx.backend.interactionExtra!.getEmojiLikes({
          groupId,
          sequence,
          emojiId,
          ...(count !== undefined ? { count } : {}),
          ...(cookie !== undefined ? { cookie } : {}),
        });
      },
    },
    { available: (backend) => typeof backend.interactionExtra?.getEmojiLikes === 'function' },
  ),
);

const reactionActions = ['set_msg_emoji_like', 'set_group_reaction'].map((name) =>
  defineAction(
    {
      name,
      summary: '给群消息贴 / 撤表情回应',
      parse: (raw) => ({
        messageId: requiredPositiveInt(raw, 'message_id'),
        emojiId: requiredString(raw, 'emoji_id'),
        set: optionalBool(raw, 'set', true),
      }),
      run: async ({ messageId, emojiId, set }, ctx) => {
        const { groupId, sequence } = resolveGroupAnchor(ctx, messageId);
        await ctx.backend.interactionExtra!.setReaction({
          groupId,
          sequence,
          code: emojiId,
          isSet: set,
        });
        return null;
      },
    },
    { available: (backend) => typeof backend.interactionExtra?.setReaction === 'function' },
  ),
);

const todoActions = (['set', 'complete', 'cancel'] as const).map((action) =>
  defineAction(
    {
      name: `${action}_group_todo`,
      summary: `${action === 'set' ? '设为' : action === 'complete' ? '完成' : '取消'}群待办`,
      parse: (raw) => {
        // SnowLuma 用 `message_id` 锚点；也接受显式 `group_id` + `msg_seq`。
        const msgSeq = optionalPositiveInt(raw, 'msg_seq');
        const groupId = optionalPositiveInt(raw, 'group_id');
        if (msgSeq !== undefined && groupId !== undefined) {
          return { messageId: undefined, groupId, msgSeq };
        }
        if (msgSeq !== undefined || groupId !== undefined) {
          throw new ParamError('group_id 与 msg_seq 必须成对提供');
        }
        return {
          messageId: requiredPositiveInt(raw, 'message_id'),
          groupId: undefined,
          msgSeq: undefined,
        };
      },
      run: async ({ messageId, groupId: explicitGroupId, msgSeq }, ctx) => {
        let groupId: number;
        let sequence: number;
        if (msgSeq !== undefined && explicitGroupId !== undefined) {
          groupId = explicitGroupId;
          sequence = msgSeq;
        } else {
          const anchor = resolveGroupAnchor(ctx, messageId!);
          groupId = anchor.groupId;
          sequence = anchor.sequence;
        }
        const backend = ctx.backend.groupTodo!;
        if (action === 'set') await backend.setGroupTodo(groupId, sequence);
        else if (action === 'complete') await backend.completeGroupTodo(groupId, sequence);
        else await backend.cancelGroupTodo(groupId, sequence);
        return null;
      },
    },
    { available: (backend) => typeof backend.groupTodo?.setGroupTodo === 'function' },
  ),
);

const miscActions = [
  defineAction(
    {
      name: 'get_group_todo_list',
      summary: '获取群待办列表',
      parse: (raw) => ({ groupId: requiredPositiveInt(raw, 'group_id') }),
      run: async ({ groupId }, ctx) => {
        const items = await ctx.backend.groupTodo!.getGroupTodoList(groupId);
        return {
          todos: items.map((item) => ({
            source_id: item.sourceId,
            sequence: item.sequence,
            random: item.random,
            text: item.text,
            create_time: item.createdAt,
            update_time: item.updatedAt,
            completed: item.completed,
          })),
        };
      },
    },
    { available: (backend) => typeof backend.groupTodo?.getGroupTodoList === 'function' },
  ),
  defineAction(
    {
      name: 'get_group_at_all_remain',
      summary: '获取群 @全体成员 剩余次数',
      parse: (raw) => ({ groupId: requiredPositiveInt(raw, 'group_id') }),
      run: async ({ groupId }, ctx) => {
        const remain = await ctx.backend.groupPolicy!.getGroupAtAllRemain(groupId);
        return {
          can_at_all: remain.canAtAll,
          remain_at_all_count_for_group: remain.remainCountForGroup,
          remain_at_all_count_for_uin: remain.remainCountForUin,
        };
      },
    },
    { available: (backend) => typeof backend.groupPolicy?.getGroupAtAllRemain === 'function' },
  ),
  defineAction(
    {
      name: 'translate_en2zh',
      summary: '英译中（服务端翻译）',
      parse: (raw) => ({ words: requiredWords(raw, 'words') }),
      run: async ({ words }, ctx) => ({
        words: await ctx.backend.interactionExtra!.translateEn2Zh(words),
      }),
    },
    { available: (backend) => typeof backend.interactionExtra?.translateEn2Zh === 'function' },
  ),
];

const friendActions = [
  defineAction(
    {
      name: 'delete_friend',
      summary: '删除好友',
      parse: (raw) => ({ userId: requiredPositiveInt(raw, 'user_id') }),
      run: async ({ userId }, ctx) => {
        await ctx.backend.friendExtra!.deleteFriend(userId);
        return null;
      },
    },
    { available: (backend) => typeof backend.friendExtra?.deleteFriend === 'function' },
  ),
  defineAction(
    {
      name: 'set_friend_remark',
      summary: '设置好友备注',
      parse: (raw) => ({
        userId: requiredPositiveInt(raw, 'user_id'),
        remark: requiredString(raw, 'remark'),
      }),
      run: async ({ userId, remark }, ctx) => {
        await ctx.backend.friendExtra!.setFriendRemark(userId, remark);
        return null;
      },
    },
    { available: (backend) => typeof backend.friendExtra?.setFriendRemark === 'function' },
  ),
  defineAction(
    {
      name: 'get_unidirectional_friend_list',
      summary: '获取单向好友列表',
      run: async (_params: JsonObject, ctx) => ({
        friends: await ctx.backend.friendExtra!.getUnidirectionalFriends(),
      }),
    },
    {
      available: (backend) => typeof backend.friendExtra?.getUnidirectionalFriends === 'function',
    },
  ),
  defineAction(
    {
      name: 'get_doubt_friends_add_request',
      summary: '获取可疑好友申请列表',
      parse: (raw) => ({ count: optionalPositiveInt(raw, 'count') ?? 50 }),
      run: async ({ count }, ctx) => ({
        requests: await ctx.backend.friendExtra!.getDoubtFriendRequests(count),
      }),
    },
    {
      available: (backend) => typeof backend.friendExtra?.getDoubtFriendRequests === 'function',
    },
  ),
  defineAction(
    {
      name: 'set_doubt_friends_add_request',
      summary: '同意 / 拒绝可疑好友申请',
      parse: (raw) => ({
        flag: requiredString(raw, 'flag'),
        approve: optionalBool(raw, 'approve', true),
      }),
      run: async ({ flag, approve }, ctx) => {
        await ctx.backend.friendExtra!.setDoubtFriendRequest(flag, approve);
        return null;
      },
    },
    {
      available: (backend) => typeof backend.friendExtra?.setDoubtFriendRequest === 'function',
    },
  ),
];

export const EXTENDED_ACTIONS = [
  ...customFaceActions,
  ...systemFaceActions,
  ...emojiLikeActions,
  ...reactionActions,
  ...todoActions,
  ...miscActions,
  ...friendActions,
];
