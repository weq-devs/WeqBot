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
  type ActionDefinition,
  type ActionEntry,
  type ActionContext,
} from '../action-registry';
import type { SystemFaceInfo } from '../backend';
import { decodeInlineMedia, isInlineMediaSource } from '../segments';
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
      name: 'add_custom_face',
      summary: '添加收藏表情',
      parse: (raw) => {
        const file = requiredString(raw, 'file').trim();
        if (!file) throw new ParamError('file 不能为空');
        const inline = isInlineMediaSource(file) ? decodeInlineMedia(file) : undefined;
        if (isInlineMediaSource(file) && !inline) {
          throw new ParamError('file 不是合法的 base64 数据');
        }
        return { file, inline };
      },
      run: async ({ file, inline }, ctx) => ({
        emoji_id: await ctx.backend.customFace!.addCustomFace(inline ?? file),
      }),
    },
    { available: (backend) => typeof backend.customFace?.addCustomFace === 'function' },
  ),
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

/** 图文 Ark 的默认封面（SnowLuma 原样照搬）。 */
const TUWEN_ARK_DEFAULT_PREVIEW =
  'https://tangram-1251316161.file.myqcloud.com/files/20210721/e50a8e37e08f29bf1ffc7466e1950690.png';

function shareArkTarget(raw: JsonObject): {
  groupId?: number;
  userId?: number;
  phoneNumber: string;
} {
  const groupId = optionalPositiveInt(raw, 'group_id');
  const userId = optionalPositiveInt(raw, 'user_id');
  if (groupId === undefined && userId === undefined) {
    throw new ParamError('user_id 或 group_id 必须给一个');
  }
  return {
    ...(groupId !== undefined ? { groupId } : {}),
    ...(userId !== undefined ? { userId } : {}),
    phoneNumber: optionalString(raw, 'phone_number') ?? '',
  };
}

function shareArkDefinition(name: string, summary: string) {
  return defineAction(
    {
      name,
      summary,
      parse: shareArkTarget,
      run: async ({ groupId, userId, phoneNumber }, ctx) => ({
        arkMsg: await ctx.backend.contactsExtra!.getRecommendArk(
          groupId !== undefined
            ? { kind: 'group', contactId: groupId }
            : { kind: 'qq', contactId: userId!, phoneNumber },
        ),
      }),
    },
    { available: (backend) => typeof backend.contactsExtra?.getRecommendArk === 'function' },
  );
}

const sharePeer = shareArkDefinition('share_peer', '分享用户 / 群 Ark 卡片');
// NapCat 标准名；与 share_peer 完全同形。
const sendArkShare = shareArkDefinition(
  'send_ark_share',
  '分享用户 / 群 Ark 卡片（NapCat 标准名）',
);

const sendGroupArkShare = defineAction(
  {
    name: 'send_group_ark_share',
    summary: '分享群 Ark 卡片',
    parse: (raw) => ({ groupId: requiredPositiveInt(raw, 'group_id') }),
    run: async ({ groupId }, ctx) =>
      ctx.backend.contactsExtra!.getRecommendArk({ kind: 'group', contactId: groupId }),
  },
  { available: (backend) => typeof backend.contactsExtra?.getRecommendArk === 'function' },
);

/** SnowLuma 旧名；与 `send_group_ark_share` 同形。 */
const shareGroupEx: ActionEntry = {
  ...sendGroupArkShare,
  definition: {
    ...sendGroupArkShare.definition,
    name: 'share_group_ex',
  } as ActionDefinition<never, never>,
};

const sendTuwenArk = defineAction(
  {
    name: 'send_tuwen_ark',
    summary: '发送图文 Ark 卡片',
    parse: (raw) => {
      const groupId = optionalPositiveInt(raw, 'group_id');
      const userId = optionalPositiveInt(raw, 'user_id');
      if (groupId === undefined && userId === undefined) {
        throw new ParamError('user_id 或 group_id 必须给一个');
      }
      const target =
        groupId !== undefined
          ? { targetId: groupId, peerType: 1 as const }
          : { targetId: userId!, peerType: 0 as const };
      return {
        ...target,
        title: requiredString(raw, 'title'),
        desc: requiredString(raw, 'desc'),
        summary: optionalString(raw, 'summary') ?? '[分享]',
        previewUrl: optionalString(raw, 'preview_url') ?? TUWEN_ARK_DEFAULT_PREVIEW,
        jumpUrl: requiredString(raw, 'jump_url'),
      };
    },
    run: async (params, ctx) => {
      await ctx.backend.contactsExtra!.sendTuwenArk!(params);
      return null;
    },
  },
  { available: (backend) => typeof backend.contactsExtra?.sendTuwenArk === 'function' },
);

const arkActions = [sharePeer, sendArkShare, sendGroupArkShare, sendTuwenArk];

function aiVoiceChatType(raw: JsonObject): number {
  const value = raw.chat_type;
  if (value === undefined || value === null) return 1;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ParamError('chat_type 必须是 >= 0 的整数');
  }
  return value;
}

function aiVoiceParams(raw: JsonObject) {
  const character = requiredString(raw, 'character').trim();
  const text = requiredString(raw, 'text').trim();
  if (!character) throw new ParamError('character 不能为空');
  if (!text) throw new ParamError('text 不能为空');
  return {
    groupId: requiredPositiveInt(raw, 'group_id'),
    character,
    text,
    chatType: aiVoiceChatType(raw),
  };
}

const getAiCharacters = defineAction(
  {
    name: 'get_ai_characters',
    summary: '获取 AI 语音角色',
    parse: (raw) => ({
      groupId: requiredPositiveInt(raw, 'group_id'),
      chatType: aiVoiceChatType(raw),
    }),
    run: async ({ groupId, chatType }, ctx) => {
      const categories = await ctx.backend.aiVoice!.listCharacters(groupId, chatType);
      return categories.map((category) => ({
        type: category.category,
        characters: category.characters.map((character) => ({
          character_id: character.characterId,
          character_name: character.characterName,
          preview_url: character.previewUrl,
        })),
      }));
    },
  },
  { available: (backend) => typeof backend.aiVoice?.listCharacters === 'function' },
);

const getAiRecord = defineAction(
  {
    name: 'get_ai_record',
    summary: '生成 AI 语音并返回下载 URL',
    parse: aiVoiceParams,
    run: async ({ groupId, character, text, chatType }, ctx) =>
      ctx.backend.aiVoice!.generate(groupId, character, text, chatType),
  },
  { available: (backend) => typeof backend.aiVoice?.generate === 'function' },
);

const sendGroupAiRecord = defineAction(
  {
    name: 'send_group_ai_record',
    summary: '生成并发送 AI 语音到群',
    parse: aiVoiceParams,
    run: async ({ groupId, character, text, chatType }, ctx) => {
      const result = await ctx.backend.aiVoice!.send(groupId, character, text, chatType);
      return {
        message_id: ctx.internSentMessageId({
          isGroup: true,
          targetId: groupId,
          sequence: result.sequence,
          clientSequence: result.clientSequence ?? 0,
          random: result.random ?? 0,
          timestamp: result.timestamp ?? Math.floor(Date.now() / 1000),
        }),
      };
    },
  },
  { available: (backend) => typeof backend.aiVoice?.send === 'function' },
);

const aiVoiceActions = [getAiCharacters, getAiRecord, sendGroupAiRecord];

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
  ...arkActions,
  shareGroupEx,
  ...aiVoiceActions,
  ...friendActions,
];
