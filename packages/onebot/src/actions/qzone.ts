/**
 * QQ 空间 action（P8.4）。
 *
 * 与消息 / 群管理不同，空间没有 push，全部是**拉取 + 主动写**；底层实现是
 * `@weqbot/protocol/web` 的 qzone cgi（凭据由 `WebCredentialSource` 提供，
 * WeqBot 默认走 OIDB `0x102a_1` → ptlogin2 jump → `0x102a_0`）。
 *
 * 参数名对齐 SnowLuma；返回体里的公共空间 JSON 目前原样透传，形状稳定的
 * （资料 / 点赞 / 评论）做了映射。
 */

import {
  defineAction,
  optionalPositiveInt,
  optionalString,
  ParamError,
  requiredPositiveInt,
  requiredString,
} from '../action-registry';
import type { JsonObject } from '../types';

function optionalTarget(raw: JsonObject): number | undefined {
  return optionalPositiveInt(raw, 'target_uin');
}

function stringArray(raw: JsonObject, key: string): string[] {
  const value = raw[key];
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') return value ? [value] : [];
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value as string[];
  }
  throw new ParamError(`${key} 必须是字符串数组`);
}

function requiredObject(raw: JsonObject, key: string): Record<string, unknown> {
  const value = raw[key];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ParamError(`${key} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

const readActions = [
  defineAction(
    {
      name: 'get_qzone_profile',
      summary: '获取空间名称与说明',
      parse: (raw) => ({ targetUin: optionalTarget(raw) }),
      run: async ({ targetUin }, ctx) => {
        const profile = await ctx.backend.qzone!.getProfile(targetUin);
        return { name: profile.name, description: profile.description };
      },
    },
    { available: (backend) => typeof backend.qzone?.getProfile === 'function' },
  ),
  defineAction(
    {
      name: 'get_qzone_msg_list',
      summary: '获取空间说说列表',
      parse: (raw) => ({
        targetUin: optionalTarget(raw),
        pos: optionalPositiveInt(raw, 'pos') ?? 0,
        num: optionalPositiveInt(raw, 'num') ?? 20,
      }),
      run: async ({ targetUin, pos, num }, ctx) =>
        ctx.backend.qzone!.getMsgList(targetUin, pos, num),
    },
    { available: (backend) => typeof backend.qzone?.getMsgList === 'function' },
  ),
  defineAction(
    {
      name: 'get_qzone_msg_detail',
      summary: '获取空间说说详情与评论',
      parse: (raw) => {
        const tid = requiredString(raw, 'tid').trim();
        if (!tid) throw new ParamError('tid 不能为空');
        const num = optionalPositiveInt(raw, 'num') ?? 20;
        if (num > 100) throw new ParamError('num 必须在 1-100 之间');
        return {
          tid,
          targetUin: optionalTarget(raw),
          pos: optionalPositiveInt(raw, 'pos') ?? 0,
          num,
        };
      },
      run: async ({ tid, targetUin, pos, num }, ctx) =>
        ctx.backend.qzone!.getMsgDetail(targetUin, tid, pos, num),
    },
    { available: (backend) => typeof backend.qzone?.getMsgDetail === 'function' },
  ),
  defineAction(
    {
      name: 'get_qzone_feeds',
      summary: '获取好友动态',
      parse: (raw) => ({
        pageNum: optionalPositiveInt(raw, 'page_num') ?? 1,
        count: optionalPositiveInt(raw, 'count') ?? 10,
        cursor: optionalString(raw, 'cursor'),
      }),
      run: async ({ pageNum, count, cursor }, ctx) =>
        ctx.backend.qzone!.getFeeds(pageNum, count, cursor),
    },
    { available: (backend) => typeof backend.qzone?.getFeeds === 'function' },
  ),
  defineAction(
    {
      name: 'get_qzone_public_capabilities',
      summary: '查询空友推荐入口与「推」能力',
      run: async (_params: JsonObject, ctx) => ctx.backend.qzone!.getPublicCapabilities(),
    },
    { available: (backend) => typeof backend.qzone?.getPublicCapabilities === 'function' },
  ),
  defineAction(
    {
      name: 'get_qzone_public_feeds',
      summary: '读取空友推荐动态',
      parse: (raw) => ({ cursor: optionalString(raw, 'cursor') }),
      run: async ({ cursor }, ctx) => ctx.backend.qzone!.getPublicFeeds(cursor),
    },
    { available: (backend) => typeof backend.qzone?.getPublicFeeds === 'function' },
  ),
  defineAction(
    {
      name: 'get_qzone_public_feed_detail',
      summary: '读取空友推荐动态详情',
      parse: (raw) => ({ feed: requiredObject(raw, 'feed') }),
      run: async ({ feed }, ctx) => ctx.backend.qzone!.getPublicFeedDetail(feed),
    },
    { available: (backend) => typeof backend.qzone?.getPublicFeedDetail === 'function' },
  ),
  defineAction(
    {
      name: 'get_qzone_public_comments',
      summary: '读取空友推荐动态评论',
      parse: (raw) => ({
        feed: requiredObject(raw, 'feed'),
        cursor: requiredString(raw, 'cursor'),
      }),
      run: async ({ feed, cursor }, ctx) => ctx.backend.qzone!.getPublicComments(feed, cursor),
    },
    { available: (backend) => typeof backend.qzone?.getPublicComments === 'function' },
  ),
  defineAction(
    {
      name: 'get_qzone_public_replies',
      summary: '读取空友推荐动态的评论回复',
      parse: (raw) => ({
        feed: requiredObject(raw, 'feed'),
        comment: requiredObject(raw, 'comment'),
        cursor: optionalString(raw, 'cursor'),
        pageSize: optionalPositiveInt(raw, 'page_size') ?? 20,
      }),
      run: async ({ feed, comment, cursor, pageSize }, ctx) =>
        ctx.backend.qzone!.getPublicReplies(feed, comment, cursor, pageSize),
    },
    { available: (backend) => typeof backend.qzone?.getPublicReplies === 'function' },
  ),
];

const writeActions = [
  defineAction(
    {
      name: 'set_qzone_profile',
      summary: '修改空间名称 / 说明',
      parse: (raw) => {
        const name = optionalString(raw, 'name');
        const description = optionalString(raw, 'description');
        if (name === undefined && description === undefined) {
          throw new ParamError('至少提供 name 或 description 之一');
        }
        return { name, description };
      },
      run: async ({ name, description }, ctx) => {
        await ctx.backend.qzone!.setProfile({ name, description });
        return null;
      },
    },
    { available: (backend) => typeof backend.qzone?.setProfile === 'function' },
  ),
  defineAction(
    {
      name: 'send_qzone_msg',
      summary: '发表说说',
      parse: (raw) => ({
        content: requiredString(raw, 'content'),
        images: stringArray(raw, 'images'),
        ugcRight: optionalPositiveInt(raw, 'ugc_right'),
        targetUins: stringArray(raw, 'target_uins'),
      }),
      run: async ({ content, images, ugcRight, targetUins }, ctx) =>
        ctx.backend.qzone!.publish(content, images, ugcRight, targetUins),
    },
    { available: (backend) => typeof backend.qzone?.publish === 'function' },
  ),
  defineAction(
    {
      name: 'delete_qzone_msg',
      summary: '删除说说',
      parse: (raw) => ({
        targetUin: optionalTarget(raw),
        tid: requiredString(raw, 'tid'),
      }),
      run: async ({ targetUin, tid }, ctx) => {
        await ctx.backend.qzone!.deleteMsg(targetUin, tid);
        return null;
      },
    },
    { available: (backend) => typeof backend.qzone?.deleteMsg === 'function' },
  ),
  defineAction(
    {
      name: 'like_qzone',
      summary: '点赞说说',
      parse: (raw) => ({
        targetUin: optionalTarget(raw),
        tid: requiredString(raw, 'tid'),
      }),
      run: async ({ targetUin, tid }, ctx) => {
        await ctx.backend.qzone!.setLike(targetUin, tid, true);
        return null;
      },
    },
    { available: (backend) => typeof backend.qzone?.setLike === 'function' },
  ),
  defineAction(
    {
      name: 'unlike_qzone',
      summary: '取消点赞说说',
      parse: (raw) => ({
        targetUin: optionalTarget(raw),
        tid: requiredString(raw, 'tid'),
      }),
      run: async ({ targetUin, tid }, ctx) => {
        await ctx.backend.qzone!.setLike(targetUin, tid, false);
        return null;
      },
    },
    { available: (backend) => typeof backend.qzone?.setLike === 'function' },
  ),
  defineAction(
    {
      name: 'comment_qzone',
      summary: '评论说说或回复指定评论（楼中楼仅文字）',
      parse: (raw) => ({
        targetUin: optionalTarget(raw),
        tid: requiredString(raw, 'tid'),
        content: requiredString(raw, 'content'),
        commentId: optionalString(raw, 'comment_id'),
        commentUin: optionalString(raw, 'comment_uin'),
        replyUin: optionalString(raw, 'reply_uin'),
        replyName: optionalString(raw, 'reply_name'),
      }),
      run: async ({ targetUin, tid, content, commentId, commentUin, replyUin, replyName }, ctx) => {
        if (commentId === undefined && commentUin === undefined) {
          return ctx.backend.qzone!.comment(targetUin, tid, content);
        }
        if (!commentId || !commentUin) {
          throw new ParamError('comment_id 与 comment_uin 必须同时提供');
        }
        if ((replyUin && !replyName) || (!replyUin && replyName)) {
          throw new ParamError('reply_uin 与 reply_name 必须同时提供');
        }
        return ctx.backend.qzone!.reply(
          targetUin,
          tid,
          {
            commentId,
            commentUin,
            ...(replyUin && replyName ? { replyTo: { uin: replyUin, name: replyName } } : {}),
          },
          content,
        );
      },
    },
    { available: (backend) => typeof backend.qzone?.comment === 'function' },
  ),
  defineAction(
    {
      name: 'set_qzone_msg_right',
      summary: '修改自己空间一条说说的查看权限',
      parse: (raw) => ({
        targetUin: optionalTarget(raw),
        tid: requiredString(raw, 'tid'),
        ugcRight: optionalPositiveInt(raw, 'ugc_right') ?? 1,
        targetUins: stringArray(raw, 'target_uins'),
      }),
      run: async ({ targetUin, tid, ugcRight, targetUins }, ctx) =>
        ctx.backend.qzone!.setMsgRight(
          targetUin,
          tid,
          ugcRight,
          targetUins.length ? targetUins : undefined,
        ),
    },
    { available: (backend) => typeof backend.qzone?.setMsgRight === 'function' },
  ),
  defineAction(
    {
      name: 'set_qzone_ban',
      summary: '拉黑 / 解除拉黑（修改本账号空间黑名单）',
      parse: (raw) => ({
        userId: requiredPositiveInt(raw, 'user_id'),
        enable: raw.enable === undefined ? true : raw.enable === true || raw.enable === 1,
      }),
      run: async ({ userId, enable }, ctx) => {
        await ctx.backend.qzone!.setBan(userId, enable);
        return null;
      },
    },
    { available: (backend) => typeof backend.qzone?.setBan === 'function' },
  ),
];

// ─────────────────────── 空友爱看（推荐域）写操作 ───────────────────────
//
// `feed` / `comment` 原样来自 `get_qzone_public_feeds` / `..._comments` 的条目；
// 这里不改字段名，避免把上游未建模的字段（like_key、cell_common…）丢掉。

function optionalObject(raw: JsonObject, key: string): Record<string, unknown> | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ParamError(`${key} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

const publicWriteActions = [
  defineAction(
    {
      name: 'set_qzone_public_upvote',
      summary: '推 / 取消推一条空友动态',
      parse: (raw) => ({
        feed: requiredObject(raw, 'feed'),
        enable: raw.enable === undefined ? true : raw.enable === true || raw.enable === 1,
      }),
      run: async ({ feed, enable }, ctx) => ctx.backend.qzone!.setPublicUpvote(feed, enable),
    },
    { available: (backend) => typeof backend.qzone?.setPublicUpvote === 'function' },
  ),
  defineAction(
    {
      name: 'set_qzone_public_like',
      summary: '点赞 / 取消点赞空友动态',
      parse: (raw) => ({
        feed: requiredObject(raw, 'feed'),
        enable: raw.enable === undefined ? true : raw.enable === true || raw.enable === 1,
      }),
      run: async ({ feed, enable }, ctx) => ctx.backend.qzone!.setPublicLike(feed, enable),
    },
    { available: (backend) => typeof backend.qzone?.setPublicLike === 'function' },
  ),
  defineAction(
    {
      name: 'set_qzone_public_comment_like',
      summary: '点赞 / 取消点赞空友评论或回复',
      parse: (raw) => ({
        feed: requiredObject(raw, 'feed'),
        comment: requiredObject(raw, 'comment'),
        reply: optionalObject(raw, 'reply'),
        enable: raw.enable === undefined ? true : raw.enable === true || raw.enable === 1,
      }),
      run: async ({ feed, comment, reply, enable }, ctx) =>
        ctx.backend.qzone!.setPublicCommentLike(feed, comment, reply, enable),
    },
    { available: (backend) => typeof backend.qzone?.setPublicCommentLike === 'function' },
  ),
  defineAction(
    {
      name: 'comment_qzone_public_feed',
      summary: '评论空友动态',
      parse: (raw) => ({
        feed: requiredObject(raw, 'feed'),
        content: requiredString(raw, 'content'),
      }),
      run: async ({ feed, content }, ctx) => ctx.backend.qzone!.commentPublic(feed, content),
    },
    { available: (backend) => typeof backend.qzone?.commentPublic === 'function' },
  ),
  defineAction(
    {
      name: 'reply_qzone_public_feed',
      summary: '回复空友评论',
      parse: (raw) => ({
        feed: requiredObject(raw, 'feed'),
        comment: requiredObject(raw, 'comment'),
        content: requiredString(raw, 'content'),
        reply: optionalObject(raw, 'reply'),
      }),
      run: async ({ feed, comment, content, reply }, ctx) =>
        ctx.backend.qzone!.replyPublic(feed, comment, content, reply),
    },
    { available: (backend) => typeof backend.qzone?.replyPublic === 'function' },
  ),
  defineAction(
    {
      name: 'delete_qzone_public_comment',
      summary: '删除自己的空友评论',
      parse: (raw) => ({
        feed: requiredObject(raw, 'feed'),
        comment: requiredObject(raw, 'comment'),
      }),
      run: async ({ feed, comment }, ctx) => {
        await ctx.backend.qzone!.deletePublicComment(feed, comment);
        return null;
      },
    },
    { available: (backend) => typeof backend.qzone?.deletePublicComment === 'function' },
  ),
  defineAction(
    {
      name: 'delete_qzone_public_reply',
      summary: '删除自己的空友回复',
      parse: (raw) => ({
        feed: requiredObject(raw, 'feed'),
        comment: requiredObject(raw, 'comment'),
        reply: requiredObject(raw, 'reply'),
      }),
      run: async ({ feed, comment, reply }, ctx) => {
        await ctx.backend.qzone!.deletePublicReply(feed, comment, reply);
        return null;
      },
    },
    { available: (backend) => typeof backend.qzone?.deletePublicReply === 'function' },
  ),
  defineAction(
    {
      name: 'set_qzone_public_follow',
      summary: '蹲 / 取消蹲空友动态作者',
      parse: (raw) => ({
        feed: requiredObject(raw, 'feed'),
        enable: raw.enable === undefined ? true : raw.enable === true || raw.enable === 1,
      }),
      run: async ({ feed, enable }, ctx) => ctx.backend.qzone!.setPublicFollow(feed, enable),
    },
    { available: (backend) => typeof backend.qzone?.setPublicFollow === 'function' },
  ),
  defineAction(
    {
      name: 'forward_qzone_public_feed',
      summary: '转发空友动态',
      parse: (raw) => ({
        feed: requiredObject(raw, 'feed'),
        reason: optionalString(raw, 'reason') ?? '',
      }),
      run: async ({ feed, reason }, ctx) => ctx.backend.qzone!.forwardPublicFeed(feed, reason),
    },
    { available: (backend) => typeof backend.qzone?.forwardPublicFeed === 'function' },
  ),
];

const feedActions = [
  defineAction(
    {
      name: 'get_qzone_home_feeds',
      summary: '读取空间主页完整动态',
      parse: (raw) => ({
        targetUin: optionalTarget(raw),
        cursor: optionalString(raw, 'cursor'),
      }),
      run: async ({ targetUin, cursor }, ctx) => ctx.backend.qzone!.getHomeFeeds(targetUin, cursor),
    },
    { available: (backend) => typeof backend.qzone?.getHomeFeeds === 'function' },
  ),
  defineAction(
    {
      name: 'get_qzone_feed_detail',
      summary: '按 tid 读取完整空间动态',
      parse: (raw) => ({ tid: requiredString(raw, 'tid') }),
      run: async ({ tid }, ctx) => ctx.backend.qzone!.getFeedDetail(tid),
    },
    { available: (backend) => typeof backend.qzone?.getFeedDetail === 'function' },
  ),
  defineAction(
    {
      name: 'get_qzone_share_ark',
      summary: '用完整空间动态生成分享卡片',
      parse: (raw) => ({ feed: requiredObject(raw, 'feed') }),
      run: async ({ feed }, ctx) => ctx.backend.qzone!.getShareArk(feed),
    },
    { available: (backend) => typeof backend.qzone?.getShareArk === 'function' },
  ),
];

export const QZONE_ACTIONS = [
  ...readActions,
  ...writeActions,
  ...publicWriteActions,
  ...feedActions,
];
