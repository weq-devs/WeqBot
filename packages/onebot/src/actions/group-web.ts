/**
 * 群侧的 web cgi action（P8.5）。
 *
 * 搬运自 SnowLuma 的 `actions/{group-info,extended}.ts`（群公告 / 荣誉 / 打卡 /
 * 精华）与 `actions/group-album.ts`（群相册）。协议实现统一在
 * `@weqbot/protocol/web`，这里只做参数归一与能力判定。
 *
 * 相册写操作（点赞 / 评论 / 删除）需要 `batch_id` + `lloc`：两者都来自
 * `get_group_album_media_list` 的条目（`batchId` / `image.lloc` 或 `video.id`）。
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

/** 0 合法的整数字段（`pinned` / `tip_window_type`）不能用 `optionalPositiveInt`。 */
function optionalInt(raw: JsonObject, key: string): number | undefined {
  const value = raw[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ParamError(`${key} 必须是非负整数`);
  }
  return value;
}

function requireMediaFile(raw: JsonObject, key: string): string {
  const value = raw[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new ParamError(`${key} 必须是 base64 或 http(s) URL`);
  }
  return value.trim();
}

/** base64（可带 data: 前缀）或 http(s) URL → 字节。 */
async function fileBytes(value: string): Promise<Uint8Array> {
  const comma = value.startsWith('data:') ? value.indexOf(',') : -1;
  const payload = comma >= 0 ? value.slice(comma + 1) : value;
  if (comma < 0 && /^https?:\/\//i.test(payload)) {
    const response = await fetch(payload);
    if (!response.ok) throw new Error(`文件下载失败：HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
  const bytes = new Uint8Array(Buffer.from(payload, 'base64'));
  if (bytes.length === 0) throw new ParamError('文件内容为空或不是合法 base64');
  return bytes;
}

function honorType(raw: JsonObject): 'all' | 'talkative' | 'performer' | 'legend' | 'emotion' {
  const value = raw.type ?? 'all';
  if (value === 1 || value === 'talkative') return 'talkative';
  if (value === 2 || value === 'performer') return 'performer';
  if (value === 3 || value === 'legend') return 'legend';
  if (value === 6 || value === 'emotion') return 'emotion';
  if (value === 'all' || value === 0 || value === undefined) return 'all';
  throw new ParamError('type 只能是 all / talkative / performer / legend / emotion');
}

export const GROUP_WEB_ACTIONS = [
  // ─────────────────────────── 群公告 ───────────────────────────

  defineAction(
    {
      name: '_get_group_notice',
      summary: '获取群公告',
      parse: (raw) => ({ groupId: requiredPositiveInt(raw, 'group_id') }),
      run: async ({ groupId }, ctx) => ctx.backend.groupNotice!.getGroupNotice(groupId),
    },
    { available: (backend) => typeof backend.groupNotice?.getGroupNotice === 'function' },
  ),

  defineAction(
    {
      name: '_send_group_notice',
      summary: '发送群公告（支持置顶 / 新成员 / 弹窗 / 确认）',
      parse: (raw) => ({
        groupId: requiredPositiveInt(raw, 'group_id'),
        content: requiredString(raw, 'content'),
        image: optionalString(raw, 'image'),
        pinned: optionalInt(raw, 'pinned') ?? 0,
        type: optionalInt(raw, 'type'),
        sendToNewMembers:
          raw.send_to_new_members === undefined
            ? undefined
            : raw.send_to_new_members === true ||
              raw.send_to_new_members === 1 ||
              raw.send_to_new_members === 'true',
        isShowEditCard: optionalInt(raw, 'is_show_edit_card'),
        tipWindowType: optionalInt(raw, 'tip_window_type'),
        confirmRequired: optionalInt(raw, 'confirm_required'),
      }),
      run: async (params, ctx) => {
        if (!params.content.trim()) throw new ParamError('content 不能为空');
        await ctx.backend.groupNotice!.sendGroupNotice(params);
        return null;
      },
    },
    { available: (backend) => typeof backend.groupNotice?.sendGroupNotice === 'function' },
  ),

  defineAction(
    {
      name: '_del_group_notice',
      summary: '删除群公告（fid / notice_id 二选一）',
      parse: (raw) => {
        const groupId = requiredPositiveInt(raw, 'group_id');
        const fid = optionalString(raw, 'fid') ?? optionalString(raw, 'notice_id');
        if (!fid) throw new ParamError('fid 或 notice_id 必须给一个');
        return { groupId, fid };
      },
      run: async ({ groupId, fid }, ctx) => {
        await ctx.backend.groupNotice!.deleteGroupNotice(groupId, fid);
        return null;
      },
    },
    { available: (backend) => typeof backend.groupNotice?.deleteGroupNotice === 'function' },
  ),

  // ─────────────────────────── 群荣誉 / 打卡 / 精华 ───────────────────────────

  defineAction(
    {
      name: 'get_group_honor_info',
      summary: '获取群荣誉信息（龙王 / 群聊之火 / 传说 / 快乐源泉）',
      parse: (raw) => ({
        groupId: requiredPositiveInt(raw, 'group_id'),
        type: honorType(raw),
      }),
      run: async ({ groupId, type }, ctx) => {
        const honor = await ctx.backend.groupHonor!.getGroupHonor(groupId, type);
        return { group_id: groupId, ...honor };
      },
    },
    { available: (backend) => typeof backend.groupHonor?.getGroupHonor === 'function' },
  ),

  defineAction(
    {
      name: 'get_group_signed_list',
      summary: '获取群今日打卡列表',
      parse: (raw) => ({
        groupId: requiredPositiveInt(raw, 'group_id'),
        dayYmd: optionalString(raw, 'day_ymd'),
        offset: optionalPositiveInt(raw, 'offset'),
        limit: optionalPositiveInt(raw, 'limit'),
      }),
      run: async ({ groupId, dayYmd, offset, limit }, ctx) =>
        ctx.backend.groupSignin!.getSignedList({ groupId, dayYmd, offset, limit }),
    },
    { available: (backend) => typeof backend.groupSignin?.getSignedList === 'function' },
  ),

  defineAction(
    {
      name: 'get_essence_msg_list',
      summary: '获取群精华消息列表',
      parse: (raw) => ({
        groupId: requiredPositiveInt(raw, 'group_id'),
        pageStart: optionalPositiveInt(raw, 'page_start') ?? 0,
        pageLimit: optionalPositiveInt(raw, 'page_limit') ?? 50,
      }),
      run: async ({ groupId, pageStart, pageLimit }, ctx) => {
        const page = await ctx.backend.groupEssence!.getEssence(groupId, pageStart, pageLimit);
        return page.messages;
      },
    },
    { available: (backend) => typeof backend.groupEssence?.getEssence === 'function' },
  ),

  // ─────────────────────────── 群相册 ───────────────────────────

  defineAction(
    {
      name: 'get_group_album_list',
      summary: '获取群相册列表',
      parse: (raw) => ({ groupId: requiredPositiveInt(raw, 'group_id') }),
      run: async ({ groupId }, ctx) => ctx.backend.groupAlbum!.listAlbums(groupId),
    },
    { available: (backend) => typeof backend.groupAlbum?.listAlbums === 'function' },
  ),

  defineAction(
    {
      name: 'upload_image_to_qun_album',
      summary: '上传图片到群相册',
      parse: (raw) => ({
        groupId: requiredPositiveInt(raw, 'group_id'),
        albumId: requiredString(raw, 'album_id'),
        albumName: requiredString(raw, 'album_name'),
        file: requireMediaFile(raw, 'file'),
        fileName: optionalString(raw, 'file_name'),
      }),
      run: async ({ groupId, albumId, albumName, file, fileName }, ctx) => {
        if (!albumId.trim() || !albumName.trim()) {
          throw new ParamError('album_id / album_name 不能为空');
        }
        const image = await fileBytes(file);
        await ctx.backend.groupAlbum!.uploadImage({
          groupId,
          albumId,
          albumName,
          image,
          ...(fileName ? { fileName } : {}),
        });
        return null;
      },
    },
    { available: (backend) => typeof backend.groupAlbum?.uploadImage === 'function' },
  ),

  defineAction(
    {
      name: 'get_group_album_media_list',
      summary: '获取群相册媒体列表',
      parse: (raw) => ({
        groupId: requiredPositiveInt(raw, 'group_id'),
        albumId: requiredString(raw, 'album_id'),
        attachInfo: optionalString(raw, 'attach_info') ?? '',
      }),
      run: async ({ groupId, albumId, attachInfo }, ctx) =>
        ctx.backend.groupAlbum!.listMedia(groupId, albumId, attachInfo),
    },
    { available: (backend) => typeof backend.groupAlbum?.listMedia === 'function' },
  ),

  defineAction(
    {
      name: 'do_group_album_comment',
      summary: '评论群相册媒体',
      parse: (raw) => ({
        groupId: requiredPositiveInt(raw, 'group_id'),
        albumId: requiredString(raw, 'album_id'),
        lloc: requiredString(raw, 'lloc'),
        content: requiredString(raw, 'content'),
        batchId: optionalString(raw, 'batch_id'),
      }),
      run: async ({ groupId, albumId, lloc, content, batchId }, ctx) => {
        if (!content.trim()) throw new ParamError('content 不能为空');
        return ctx.backend.groupAlbum!.comment({
          groupId,
          albumId,
          lloc,
          content,
          ...(batchId ? { batchId } : {}),
        });
      },
    },
    { available: (backend) => typeof backend.groupAlbum?.comment === 'function' },
  ),

  defineAction(
    {
      name: 'set_group_album_media_like',
      summary: '点赞群相册媒体',
      parse: (raw) => ({
        groupId: requiredPositiveInt(raw, 'group_id'),
        albumId: requiredString(raw, 'album_id'),
        batchId: requiredString(raw, 'batch_id'),
        lloc: optionalString(raw, 'lloc'),
      }),
      run: async ({ groupId, albumId, batchId, lloc }, ctx) =>
        ctx.backend.groupAlbum!.setLike({ groupId, albumId, batchId, lloc, like: true }),
    },
    { available: (backend) => typeof backend.groupAlbum?.setLike === 'function' },
  ),

  defineAction(
    {
      name: 'cancel_group_album_media_like',
      summary: '取消点赞群相册媒体',
      parse: (raw) => ({
        groupId: requiredPositiveInt(raw, 'group_id'),
        albumId: requiredString(raw, 'album_id'),
        batchId: requiredString(raw, 'batch_id'),
        lloc: optionalString(raw, 'lloc'),
      }),
      run: async ({ groupId, albumId, batchId, lloc }, ctx) =>
        ctx.backend.groupAlbum!.setLike({ groupId, albumId, batchId, lloc, like: false }),
    },
    { available: (backend) => typeof backend.groupAlbum?.setLike === 'function' },
  ),

  defineAction(
    {
      name: 'del_group_album_media',
      summary: '删除群相册图片或视频',
      parse: (raw) => ({
        groupId: requiredPositiveInt(raw, 'group_id'),
        albumId: requiredString(raw, 'album_id'),
        lloc: requiredString(raw, 'lloc'),
        batchId: optionalString(raw, 'batch_id'),
      }),
      run: async ({ groupId, albumId, lloc, batchId }, ctx) => {
        await ctx.backend.groupAlbum!.deleteMedia({
          groupId,
          albumId,
          lloc,
          ...(batchId ? { batchId } : {}),
        });
        return null;
      },
    },
    { available: (backend) => typeof backend.groupAlbum?.deleteMedia === 'function' },
  ),
];
