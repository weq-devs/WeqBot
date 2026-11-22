/**
 * 闪传（FlashTransfer）action。
 *
 * 参数名 / 返回字段对齐 SnowLuma；只有 `get_flash_file_url` 与 `download_fileset`
 * 故意不在这里 —— 主文件直链要 0x93D4 / 0x12A9_200，WeqBot 协议层还没搬，
 * 0x93D3 的 `download_url` 只是缩略图，不能拿它冒充。
 */

import {
  defineAction,
  optionalPositiveInt,
  optionalString,
  ParamError,
  requiredString,
} from '../action-registry';
import type { FlashFileItem } from '../backend';
import type { JsonObject } from '../types';

function flashFileOut(file: FlashFileItem) {
  return {
    fileset_id: file.filesetId,
    file_name: file.fileName,
    orig_name: file.origName,
    size: file.fileSize,
    share_url: file.shareUrl,
    file_id: file.fileId,
    download_url: file.downloadUrl,
  };
}

/** `files`：路径字符串、`{ file, name }`，或它们的数组。 */
function flashFiles(raw: JsonObject): Array<{ path: string; name?: string }> {
  const value = raw.files;
  const entries = Array.isArray(value) ? value : value === undefined ? [] : [value];
  if (entries.length === 0) throw new ParamError('files 不能为空');

  return entries.map((entry) => {
    if (typeof entry === 'string') {
      const path = entry.trim();
      if (!path) throw new ParamError('files 里的路径不能为空');
      return { path };
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ParamError('files 必须是路径或 { file, name }');
    }
    const item = entry as Record<string, unknown>;
    const path = typeof item.file === 'string' ? item.file.trim() : '';
    if (!path) throw new ParamError('files 条目缺少 file');
    const name = item.name;
    if (name !== undefined && typeof name !== 'string') {
      throw new ParamError('files 条目的 name 必须是字符串');
    }
    return { path, ...(name ? { name } : {}) };
  });
}

function filesetId(raw: JsonObject): string {
  const value = requiredString(raw, 'fileset_id').trim();
  if (!value) throw new ParamError('fileset_id 不能为空');
  return value;
}

function parsePageCursor(raw: JsonObject): Uint8Array | undefined {
  const cursor = optionalString(raw, 'cursor');
  if (cursor === undefined) return undefined;
  if (!cursor || cursor.length > 4096) throw new ParamError('cursor 必须是返回的 Base64 游标');
  const bytes = Buffer.from(cursor, 'base64');
  if (bytes.toString('base64') !== cursor) throw new ParamError('cursor 必须是返回的 Base64 游标');
  return bytes;
}

export const FLASH_TRANSFER_ACTIONS = [
  defineAction(
    {
      name: 'create_flash_task',
      summary: '创建闪传任务',
      parse: (raw) => ({
        files: flashFiles(raw),
        name: optionalString(raw, 'name') || undefined,
        thumbPath: optionalString(raw, 'thumb_path') || undefined,
      }),
      run: async ({ files, name, thumbPath }, ctx) => {
        const result = await ctx.backend.flashTransfer!.createTask(files, name, thumbPath);
        return { fileset_id: result.filesetId, task_id: result.filesetId };
      },
    },
    { available: (backend) => typeof backend.flashTransfer?.createTask === 'function' },
  ),
  defineAction(
    {
      name: 'get_fileset_info',
      summary: '获取闪传文件集信息',
      parse: (raw) => ({ filesetId: filesetId(raw) }),
      run: async ({ filesetId: id }, ctx) => ({
        fileset_id: id,
        file_list: (await ctx.backend.flashTransfer!.getFilesetInfo(id)).map(flashFileOut),
      }),
    },
    { available: (backend) => typeof backend.flashTransfer?.getFilesetInfo === 'function' },
  ),
  defineAction(
    {
      name: 'get_flash_file_list',
      summary: '获取闪传文件列表',
      parse: (raw) => ({ filesetId: filesetId(raw) }),
      run: async ({ filesetId: id }, ctx) =>
        (await ctx.backend.flashTransfer!.getFilesetInfo(id)).map(flashFileOut),
    },
    { available: (backend) => typeof backend.flashTransfer?.getFilesetInfo === 'function' },
  ),
  defineAction(
    {
      name: 'list_filesets',
      summary: '列出当前账号的闪传文件集',
      run: async (_params: JsonObject, ctx) =>
        (await ctx.backend.flashTransfer!.listFilesets()).map(flashFileOut),
    },
    { available: (backend) => typeof backend.flashTransfer?.listFilesets === 'function' },
  ),
  defineAction(
    {
      name: 'list_filesets_page',
      summary: '分页列出当前账号的闪传文件集',
      parse: (raw) => {
        const cursor = parsePageCursor(raw);
        const limit = optionalPositiveInt(raw, 'limit');
        if (limit !== undefined && limit > 100) throw new ParamError('limit 不能超过 100');
        return { ...(cursor ? { cursor } : {}), ...(limit === undefined ? {} : { limit }) };
      },
      run: async (params, ctx) => {
        const page = await ctx.backend.flashTransfer!.listFilesetsPage!(params);
        return {
          items: page.items.map(flashFileOut),
          total: page.total,
          is_end: page.nextCursor === null,
          next_cursor: page.nextCursor ? Buffer.from(page.nextCursor).toString('base64') : null,
        };
      },
    },
    { available: (backend) => typeof backend.flashTransfer?.listFilesetsPage === 'function' },
  ),
  defineAction(
    {
      name: 'get_share_link',
      summary: '获取闪传分享链接',
      parse: (raw) => ({ filesetId: filesetId(raw) }),
      run: async ({ filesetId: id }, ctx) => ctx.backend.flashTransfer!.getShareLink(id),
    },
    { available: (backend) => typeof backend.flashTransfer?.getShareLink === 'function' },
  ),
  defineAction(
    {
      name: 'delete_flash_file',
      summary: '删除闪传文件集',
      parse: (raw) => ({ filesetId: filesetId(raw) }),
      run: async ({ filesetId: id }, ctx) => {
        await ctx.backend.flashTransfer!.deleteFile(id);
        return null;
      },
    },
    { available: (backend) => typeof backend.flashTransfer?.deleteFile === 'function' },
  ),
  defineAction(
    {
      name: 'rename_flash_file',
      summary: '重命名闪传文件集',
      parse: (raw) => {
        const newName = requiredString(raw, 'new_name').trim();
        if (!newName) throw new ParamError('new_name 不能为空');
        return { filesetId: filesetId(raw), newName };
      },
      run: async ({ filesetId: id, newName }, ctx) => {
        await ctx.backend.flashTransfer!.renameFile(id, newName);
        return null;
      },
    },
    { available: (backend) => typeof backend.flashTransfer?.renameFile === 'function' },
  ),
  defineAction(
    {
      name: 'send_flash_msg',
      summary: '发送闪传分享消息',
      parse: (raw) => ({
        filesetId: filesetId(raw),
        groupId: optionalPositiveInt(raw, 'group_id'),
        userId: optionalPositiveInt(raw, 'user_id'),
      }),
      run: async ({ filesetId: id, groupId, userId }, ctx) => {
        if (groupId === undefined && userId === undefined) {
          throw new ParamError('user_id 或 group_id 必须给一个');
        }
        await ctx.backend.flashTransfer!.sendFlashMsg(id, {
          ...(groupId !== undefined ? { groupId } : {}),
          ...(userId !== undefined ? { userId } : {}),
        });
        // 0x93D7 是分享 fileset，不是普通消息，没有 message_id。
        return { message_id: 0 };
      },
    },
    { available: (backend) => typeof backend.flashTransfer?.sendFlashMsg === 'function' },
  ),
  defineAction(
    {
      name: 'get_flash_file_url',
      summary: '获取闪传主文件直链',
      parse: (raw) => ({
        filesetId: filesetId(raw),
        fileIndex: optionalPositiveInt(raw, 'file_index') ?? 1,
      }),
      run: async ({ filesetId: id, fileIndex }, ctx) => ({
        url: await ctx.backend.flashTransfer!.getFileUrl(id, fileIndex),
      }),
    },
    { available: (backend) => typeof backend.flashTransfer?.getFileUrl === 'function' },
  ),
  defineAction(
    {
      name: 'download_fileset',
      summary: '解析闪传主文件直链（不下载字节）',
      parse: (raw) => ({
        filesetId: filesetId(raw),
        fileIndex: optionalPositiveInt(raw, 'file_index') ?? 1,
      }),
      run: async ({ filesetId: id, fileIndex }, ctx) => {
        const file = await ctx.backend.flashTransfer!.downloadFileset(id, fileIndex);
        return { url: file.url, file_name: file.fileName, file_size: file.fileSize };
      },
    },
    { available: (backend) => typeof backend.flashTransfer?.downloadFileset === 'function' },
  ),
  defineAction(
    {
      name: 'get_fileset_id',
      summary: '从闪传分享码 / 链接解析文件集 id',
      parse: (raw) => {
        const shareCode = requiredString(raw, 'share_code').trim();
        if (!shareCode) throw new ParamError('share_code 不能为空');
        return { shareCode };
      },
      run: async ({ shareCode }, ctx) => ({
        fileset_id: await ctx.backend.flashTransfer!.getFilesetIdByCode(shareCode),
      }),
    },
    {
      available: (backend) => typeof backend.flashTransfer?.getFilesetIdByCode === 'function',
    },
  ),
];
