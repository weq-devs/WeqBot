/**
 * 闪传的列表 / 删除 / 重命名：0x93d2_1 / 0x9407_1 / 0x9427_0。
 *
 * 搬运自 SnowLuma `packages/protocol/src/oidb-services/flash-transfer/{list-filesets,delete-file,rename-file}.ts`
 * （2026-11-13），改为 WeqBot 的 `message()` schema 写法。
 *
 * ⚠️ `0x9427_0` 的信封与其他闪传命令不同：`subCommand=0`（不是 1）且
 * `uinForm=true`。按 `0x93cf_1` 类推用 sub=1 会被服务端以「no privilege」拒绝。
 *
 * 签名：三条都不在 WeQ 的 SIGN_RULES 里（SnowLuma 也未记录），**三端待实测**。
 */

import { message } from '../../protobuf';
import { invokeOidb, type OidbSpec } from '../invoke';
import { toInt } from '../shared';
import type { OidbNative } from '../../transport';

const FLASH_RESOURCE_URL = message([{ name: 'field1', tag: 1, type: 'string' }]);

const FLASH_FILE_ID_WRAP = message([{ name: 'fileId', tag: 1, type: 'string' }]);

const FLASH_FILE_ENTRY = message([
  { name: 'filesetUuid', tag: 1, type: 'string' },
  { name: 'fileName', tag: 2, type: 'string' },
  { name: 'origName', tag: 3, type: 'string' },
  { name: 'fileType', tag: 4, type: 'uint32' },
  { name: 'fileSize', tag: 5, type: 'uint64' },
  { name: 'uploadUrlWrap', tag: 8, type: FLASH_RESOURCE_URL },
  { name: 'fileIdWrap', tag: 9, type: FLASH_FILE_ID_WRAP },
]);

const LIST_FILESETS_REQ = message([
  { name: 'field1', tag: 1, type: 'uint32' },
  { name: 'field2', tag: 2, type: 'string' },
  { name: 'field3', tag: 3, type: 'uint32' },
]);

const LIST_FILESETS_RESP = message([
  { name: 'entries', tag: 1, type: FLASH_FILE_ENTRY, repeated: true },
]);

const DELETE_FILE_REQ = message([
  { name: 'filesetUuid', tag: 1, type: 'string' },
  { name: 'field2', tag: 2, type: 'string' },
  { name: 'field3', tag: 3, type: 'uint32' },
]);

const RENAME_FILE_NAME = message([
  { name: 'newName', tag: 1, type: 'string' },
  { name: 'displayName', tag: 2, type: 'string' },
]);

const RENAME_FILE_FLAG = message([{ name: 'field1', tag: 1, type: 'uint32' }]);

const RENAME_FILE_REQ = message([
  { name: 'filesetUuid', tag: 1, type: 'string' },
  { name: 'name', tag: 2, type: RENAME_FILE_NAME },
  { name: 'flag', tag: 3, type: RENAME_FILE_FLAG },
]);

export interface FlashFileEntry {
  filesetUuid: string;
  fileName: string;
  origName: string;
  fileType: number;
  fileSize: number;
  uploadUrl: string;
  fileId: string;
}

export interface ListFilesetsParams {
  /** 默认 3。 */
  field1?: number;
  /** 默认 10。 */
  field3?: number;
}

export namespace ListFilesets {
  export const command = 0x93d2;
  export const subCommand = 1;

  export const reqSchema = LIST_FILESETS_REQ;
  export const respSchema = LIST_FILESETS_RESP;

  export function serialize(params: ListFilesetsParams = {}): Record<string, unknown> {
    return { field1: params.field1 ?? 3, field2: '', field3: params.field3 ?? 10 };
  }

  export function deserialize(body: Record<string, unknown>): FlashFileEntry[] {
    return ((body.entries as Record<string, unknown>[] | undefined) ?? []).map((raw) => ({
      filesetUuid: typeof raw.filesetUuid === 'string' ? raw.filesetUuid : '',
      fileName: typeof raw.fileName === 'string' ? raw.fileName : '',
      origName: typeof raw.origName === 'string' ? raw.origName : '',
      fileType: toInt(raw.fileType),
      fileSize: toInt(raw.fileSize),
      uploadUrl:
        typeof (raw.uploadUrlWrap as Record<string, unknown> | undefined)?.field1 === 'string'
          ? String((raw.uploadUrlWrap as Record<string, unknown>).field1)
          : '',
      fileId:
        typeof (raw.fileIdWrap as Record<string, unknown> | undefined)?.fileId === 'string'
          ? String((raw.fileIdWrap as Record<string, unknown>).fileId)
          : '',
    }));
  }

  export function invoke(
    nt: OidbNative,
    sessionId: number,
    params: ListFilesetsParams = {},
  ): Promise<FlashFileEntry[]> {
    return invokeOidb(
      nt,
      sessionId,
      ListFilesets as OidbSpec<ListFilesetsParams, FlashFileEntry[]>,
      params,
    );
  }
}

export interface DeleteFlashFileParams {
  filesetUuid: string;
}

export namespace DeleteFlashFile {
  export const command = 0x9407;
  export const subCommand = 1;

  export const reqSchema = DELETE_FILE_REQ;
  export const respSchema = message([]);

  export function serialize(params: DeleteFlashFileParams): Record<string, unknown> {
    if (!params.filesetUuid) throw new Error('删除闪传文件需要 filesetUuid');
    return { filesetUuid: params.filesetUuid, field2: '', field3: 7 };
  }

  export function deserialize(): void {}

  export function invoke(
    nt: OidbNative,
    sessionId: number,
    params: DeleteFlashFileParams,
  ): Promise<void> {
    return invokeOidb(
      nt,
      sessionId,
      DeleteFlashFile as OidbSpec<DeleteFlashFileParams, void>,
      params,
    );
  }
}

export interface RenameFlashFileParams {
  filesetUuid: string;
  /** 新文件名；同时用作显示名（与 QQ 面板行为一致）。 */
  newName: string;
}

export namespace RenameFlashFile {
  export const command = 0x9427;
  /** ⚠️ 这条是 sub=0 + uinForm，别按其它闪传命令类推。 */
  export const subCommand = 0;
  export const uinForm = true;

  export const reqSchema = RENAME_FILE_REQ;
  export const respSchema = message([]);

  export function serialize(params: RenameFlashFileParams): Record<string, unknown> {
    if (!params.filesetUuid) throw new Error('重命名闪传文件需要 filesetUuid');
    if (!params.newName) throw new Error('重命名闪传文件需要新文件名');
    return {
      filesetUuid: params.filesetUuid,
      name: { newName: params.newName, displayName: params.newName },
      flag: { field1: 0 },
    };
  }

  export function deserialize(): void {}

  export function invoke(
    nt: OidbNative,
    sessionId: number,
    params: RenameFlashFileParams,
  ): Promise<void> {
    return invokeOidb(
      nt,
      sessionId,
      RenameFlashFile as OidbSpec<RenameFlashFileParams, void>,
      params,
    );
  }
}
