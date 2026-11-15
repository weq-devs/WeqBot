/**
 * 群文件类 action（P8.2）。
 *
 * 参数名 / 返回字段对齐 SnowLuma（事实标准），后端能力见 `OneBotBackend.groupFile`。
 * 没实现的能力（上传 / 转存 / 私聊文件）不注册，调用返回 1404 —— 不返回假数据。
 */

import {
  defineAction,
  optionalBool,
  optionalPositiveInt,
  optionalString,
  ParamError,
  requiredPositiveInt,
  requiredString,
} from '../action-registry';
import type { GroupFilePageResult } from '../backend';
import type { JsonObject } from '../types';

/** `file` 只接受本机路径；`file://` 前缀剥掉，base64 / http 交给后端会读不了，直接 1400。 */
function localFilePath(raw: JsonObject, key: string): string {
  const file = requiredString(raw, key).trim();
  if (!file) throw new ParamError(`${key} 不能为空`);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(file) && !file.startsWith('file://')) {
    throw new ParamError(`${key} 只支持本机路径，不支持远程 URL`);
  }
  return file.startsWith('file://') ? decodeURIComponent(file.slice('file://'.length)) : file;
}

function mapPage(groupId: number, page: GroupFilePageResult) {
  return {
    files: page.files.map((file) => ({
      group_id: groupId,
      file_id: file.fileId,
      file_name: file.fileName,
      busid: file.busId,
      file_size: file.fileSize,
      upload_time: file.uploadedTime,
      dead_time: file.expireTime,
      modify_time: file.modifiedTime,
      download_times: file.downloadedTimes,
      uploader: file.uploaderUin,
      uploader_name: file.uploaderName,
    })),
    folders: page.folders.map((folder) => ({
      group_id: groupId,
      folder_id: folder.folderId,
      folder_name: folder.folderName,
      create_time: folder.createTime,
      creator: folder.creatorUin,
      create_name: folder.creatorName,
      total_file_count: folder.totalFileCount,
      last_upload_time: folder.modifiedTime,
      last_uploader: 0,
      last_uploader_name: '',
    })),
  };
}

/** 一页一页拉到 `isEnd`；上限 50 页，防止服务端异常时不返回。 */
const MAX_PAGES = 50;
const PAGE_SIZE = 100;

async function listDirectory(
  backend: NonNullable<import('../backend').OneBotBackend['groupFile']>,
  groupId: number,
  directory: string,
): Promise<GroupFilePageResult> {
  const files: GroupFilePageResult['files'] = [];
  const folders: GroupFilePageResult['folders'] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await backend.listGroupFiles(groupId, directory, page * PAGE_SIZE, PAGE_SIZE);
    files.push(...result.files);
    folders.push(...result.folders);
    if (result.isEnd || (result.files.length === 0 && result.folders.length === 0)) break;
  }
  return { files, folders, isEnd: true };
}

const canList = (backend: import('../backend').OneBotBackend) =>
  typeof backend.groupFile?.listGroupFiles === 'function';

export const GROUP_FILE_ACTIONS = [
  defineAction(
    {
      name: 'get_group_root_files',
      summary: '获取群根目录文件列表',
      parse: (raw) => ({ groupId: requiredPositiveInt(raw, 'group_id') }),
      run: async ({ groupId }, ctx) => {
        const page = await listDirectory(ctx.backend.groupFile!, groupId, '/');
        return mapPage(groupId, page);
      },
    },
    { available: canList },
  ),
  defineAction(
    {
      name: 'get_group_files_by_folder',
      summary: '获取群文件夹内文件列表',
      parse: (raw) => ({
        groupId: requiredPositiveInt(raw, 'group_id'),
        // SnowLuma 的 `folder` 是 `folder_id` 的别名，空值 = 根目录。
        folderId: optionalString(raw, 'folder_id') ?? optionalString(raw, 'folder') ?? '/',
      }),
      run: async ({ groupId, folderId }, ctx) => {
        const page = await listDirectory(ctx.backend.groupFile!, groupId, folderId || '/');
        return mapPage(groupId, page);
      },
    },
    { available: canList },
  ),
  defineAction(
    {
      name: 'get_group_file_url',
      summary: '获取群文件下载链接',
      parse: (raw) => ({
        groupId: requiredPositiveInt(raw, 'group_id'),
        fileId: requiredString(raw, 'file_id'),
        busId: optionalPositiveInt(raw, 'busid') ?? 102,
      }),
      run: async ({ groupId, fileId, busId }, ctx) => ({
        url: await ctx.backend.groupFile!.getGroupFileUrl(groupId, fileId, busId),
      }),
    },
    { available: (backend) => typeof backend.groupFile?.getGroupFileUrl === 'function' },
  ),
  defineAction(
    {
      name: 'get_group_file_system_info',
      summary: '获取群文件系统信息（文件数 / 空间）',
      parse: (raw) => ({ groupId: requiredPositiveInt(raw, 'group_id') }),
      run: async ({ groupId }, ctx) => {
        const [count, space] = await Promise.all([
          ctx.backend.groupFile!.getGroupFileCount(groupId),
          ctx.backend.groupFile!.getGroupFileSpace(groupId),
        ]);
        return {
          file_count: count.fileCount,
          limit_count: count.maxCount,
          used_space: space.usedSpace,
          total_space: space.totalSpace,
        };
      },
    },
    {
      available: (backend) =>
        typeof backend.groupFile?.getGroupFileCount === 'function' &&
        typeof backend.groupFile?.getGroupFileSpace === 'function',
    },
  ),
  defineAction(
    {
      name: 'delete_group_file',
      summary: '删除群文件',
      parse: (raw) => ({
        groupId: requiredPositiveInt(raw, 'group_id'),
        fileId: requiredString(raw, 'file_id'),
      }),
      run: async ({ groupId, fileId }, ctx) => {
        await ctx.backend.groupFile!.deleteGroupFile(groupId, fileId);
        return null;
      },
    },
    { available: (backend) => typeof backend.groupFile?.deleteGroupFile === 'function' },
  ),
  defineAction(
    {
      name: 'move_group_file',
      summary: '移动群文件到指定文件夹',
      parse: (raw) => ({
        groupId: requiredPositiveInt(raw, 'group_id'),
        fileId: requiredString(raw, 'file_id'),
        parentDirectory: optionalString(raw, 'current_parent_directory') ?? '/',
        targetDirectory: requiredString(raw, 'target_parent_directory'),
      }),
      run: async ({ groupId, fileId, parentDirectory, targetDirectory }, ctx) => {
        await ctx.backend.groupFile!.moveGroupFile(
          groupId,
          fileId,
          parentDirectory,
          targetDirectory,
        );
        return null;
      },
    },
    { available: (backend) => typeof backend.groupFile?.moveGroupFile === 'function' },
  ),
  defineAction(
    {
      name: 'rename_group_file',
      summary: '重命名群文件',
      parse: (raw) => ({
        groupId: requiredPositiveInt(raw, 'group_id'),
        fileId: requiredString(raw, 'file_id'),
        parentDirectory: optionalString(raw, 'current_parent_directory') ?? '/',
        newName: requiredString(raw, 'new_name'),
      }),
      run: async ({ groupId, fileId, parentDirectory, newName }, ctx) => {
        await ctx.backend.groupFile!.renameGroupFile(groupId, fileId, parentDirectory, newName);
        return null;
      },
    },
    { available: (backend) => typeof backend.groupFile?.renameGroupFile === 'function' },
  ),
  defineAction(
    {
      name: 'create_group_file_folder',
      summary: '新建群文件文件夹',
      parse: (raw) => ({
        groupId: requiredPositiveInt(raw, 'group_id'),
        name: requiredString(raw, 'name'),
      }),
      run: async ({ groupId, name }, ctx) => ({
        folder_id: await ctx.backend.groupFile!.createGroupFolder(groupId, name),
      }),
    },
    { available: (backend) => typeof backend.groupFile?.createGroupFolder === 'function' },
  ),
  defineAction(
    {
      name: 'delete_group_file_folder',
      summary: '删除群文件文件夹',
      parse: (raw) => ({
        groupId: requiredPositiveInt(raw, 'group_id'),
        folderId: requiredString(raw, 'folder_id'),
      }),
      run: async ({ groupId, folderId }, ctx) => {
        await ctx.backend.groupFile!.deleteGroupFolder(groupId, folderId);
        return null;
      },
    },
    { available: (backend) => typeof backend.groupFile?.deleteGroupFolder === 'function' },
  ),
  defineAction(
    {
      name: 'get_private_file_url',
      summary: '获取私聊文件下载链接',
      parse: (raw) => ({
        userId: optionalPositiveInt(raw, 'user_id'),
        fileId: requiredString(raw, 'file_id'),
        fileHash: optionalString(raw, 'file_hash') ?? '',
      }),
      run: async ({ userId, fileId, fileHash }, ctx) => ({
        url: await ctx.backend.groupFile!.getPrivateFileUrl(userId, fileId, fileHash),
      }),
    },
    { available: (backend) => typeof backend.groupFile?.getPrivateFileUrl === 'function' },
  ),
  defineAction(
    {
      name: 'rename_group_file_folder',
      summary: '重命名群文件文件夹',
      parse: (raw) => ({
        groupId: requiredPositiveInt(raw, 'group_id'),
        folderId: requiredString(raw, 'folder_id'),
        newName: requiredString(raw, 'new_name'),
      }),
      run: async ({ groupId, folderId, newName }, ctx) => {
        await ctx.backend.groupFile!.renameGroupFolder(groupId, folderId, newName);
        return null;
      },
    },
    { available: (backend) => typeof backend.groupFile?.renameGroupFolder === 'function' },
  ),
  defineAction(
    {
      name: 'delete_group_folder',
      summary: '删除群文件夹（NapCat 别名）',
      parse: (raw) => ({
        groupId: requiredPositiveInt(raw, 'group_id'),
        folderId: requiredString(raw, 'folder_id'),
      }),
      run: async ({ groupId, folderId }, ctx) => {
        await ctx.backend.groupFile!.deleteGroupFolder(groupId, folderId);
        return null;
      },
    },
    { available: (backend) => typeof backend.groupFile?.deleteGroupFolder === 'function' },
  ),
  defineAction(
    {
      name: 'trans_group_file',
      summary: '转存群文件',
      parse: (raw) => ({
        groupId: requiredPositiveInt(raw, 'group_id'),
        fileId: requiredString(raw, 'file_id'),
      }),
      run: async ({ groupId, fileId }, ctx) => {
        await ctx.backend.groupFile!.transGroupFile(groupId, fileId);
        return { ok: true };
      },
    },
    { available: (backend) => typeof backend.groupFile?.transGroupFile === 'function' },
  ),
  defineAction(
    {
      name: 'upload_group_file',
      summary: '上传群文件',
      parse: (raw) => ({
        groupId: requiredPositiveInt(raw, 'group_id'),
        filePath: localFilePath(raw, 'file'),
        fileName: optionalString(raw, 'name') || undefined,
        folderId: optionalString(raw, 'folder') || optionalString(raw, 'folder_id') || '/',
        publish: optionalBool(raw, 'upload_file', true),
      }),
      run: async (params, ctx) => ({
        file_id: (await ctx.backend.groupFile!.uploadGroupFile(params)).fileId,
      }),
    },
    { available: (backend) => typeof backend.groupFile?.uploadGroupFile === 'function' },
  ),
  defineAction(
    {
      name: 'upload_private_file',
      summary: '上传私聊文件并发送',
      parse: (raw) => ({
        userId: requiredPositiveInt(raw, 'user_id'),
        filePath: localFilePath(raw, 'file'),
        fileName: optionalString(raw, 'name') || undefined,
        send: optionalBool(raw, 'upload_file', true),
      }),
      run: async (params, ctx) => ({
        file_id: (await ctx.backend.groupFile!.uploadPrivateFile(params)).fileId,
      }),
    },
    { available: (backend) => typeof backend.groupFile?.uploadPrivateFile === 'function' },
  ),
];
