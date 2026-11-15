// OIDB 0x93D4_1 + 0x12A9_200 — 闪传主文件下载直链。
//
// 0x93D4_1 取 fileset 内每个文件的 fileIndex / fileUuid / 主文件 fileId。
// 0x12A9_200 再用主文件 fileId 换 multimedia.qfile.qq.com/download?appid=14901…
// 响应 f3 是 bytes（host/path/rkey 混在文本里），用正则提取，不臆造 schema。
//
// 0x93D3 / 0x93D4 里的 downloadUrl 只是缩略图（appid=14902/14903），不能冒充主文件。

import { message } from '../../protobuf';
import { invokeOidb, type OidbSpec } from '../invoke';
import type { OidbNative } from '../../transport';
import {
  FLASH_APPLY_FILE_INFO,
  FLASH_APPLY_FILESET_WRAP,
  FLASH_APPLY_HEAD,
  FLASH_APPLY_HEAD_RESP,
} from './schemas';
import { nextUploadSeq } from './upload-seq';

// ───────────────────────── 0x93D4_1 ─────────────────────────

const DOWNLOAD_URL_REQ_INNER5 = message([{ name: 'field1', tag: 1, type: 'uint32' }]);
const DOWNLOAD_URL_REQ_INNER6 = message([
  { name: 'field1', tag: 1, type: 'uint32' },
  { name: 'field2', tag: 2, type: 'uint32' },
]);
const DOWNLOAD_URL_REQ_INNER = message([
  { name: 'field1', tag: 1, type: 'string' },
  { name: 'field2', tag: 2, type: 'uint32' },
  { name: 'field3', tag: 3, type: 'uint32' },
  { name: 'field4', tag: 4, type: 'string' },
  { name: 'field5', tag: 5, type: DOWNLOAD_URL_REQ_INNER5 },
  { name: 'field6', tag: 6, type: DOWNLOAD_URL_REQ_INNER6 },
]);

const DOWNLOAD_URL_REQ = message([
  { name: 'filesetUuid', tag: 1, type: 'string' },
  { name: 'inner', tag: 2, type: DOWNLOAD_URL_REQ_INNER },
  { name: 'field3', tag: 3, type: 'uint32' },
  { name: 'field4', tag: 4, type: 'uint32' },
]);

const DOWNLOAD_URL_INFO_WRAP = message([
  { name: 'field1', tag: 1, type: 'uint32' },
  { name: 'downloadUrl', tag: 2, type: 'string' },
]);

const DOWNLOAD_URL_INFO = message([
  { name: 'fileId', tag: 1, type: 'string' },
  { name: 'download', tag: 2, type: DOWNLOAD_URL_INFO_WRAP },
  { name: 'sha1', tag: 3, type: 'string' },
  { name: 'field4', tag: 4, type: 'uint32' },
  { name: 'md5', tag: 5, type: 'string' },
  { name: 'width', tag: 6, type: 'uint32' },
  { name: 'height', tag: 7, type: 'uint32' },
]);

const DOWNLOAD_MAIN_FILE = message([
  { name: 'fileId', tag: 1, type: 'string' },
  { name: 'field3', tag: 3, type: 'uint32' },
]);

const DOWNLOAD_FILE_INFO = message([
  { name: 'filesetUuid', tag: 1, type: 'string' },
  { name: 'fileUuid', tag: 2, type: 'string' },
  { name: 'field5', tag: 5, type: 'uint32' },
  { name: 'field6', tag: 6, type: 'uint32' },
  { name: 'field7', tag: 7, type: 'uint32' },
  { name: 'fileName', tag: 8, type: 'string' },
  { name: 'origName', tag: 9, type: 'string' },
  { name: 'fileSize', tag: 11, type: 'uint64' },
  { name: 'downloadInfo', tag: 13, type: DOWNLOAD_URL_INFO },
  { name: 'mainFile', tag: 14, type: DOWNLOAD_MAIN_FILE },
]);

const DOWNLOAD_ENTRY = message([
  { name: 'field2', tag: 2, type: 'uint32' },
  { name: 'fileInfo', tag: 3, type: DOWNLOAD_FILE_INFO, repeated: true },
  { name: 'field4', tag: 4, type: 'string' },
  { name: 'field5', tag: 5, type: 'uint32' },
]);

const DOWNLOAD_URL_RESP = message([{ name: 'entry', tag: 1, type: DOWNLOAD_ENTRY }]);

export interface FlashDownloadFileMeta {
  fileIndex: number;
  fileId: string;
  filesetUuid: string;
  fileUuid: string;
  fileName: string;
  fileSize: number;
}

export namespace GetFlashDownloadUrl {
  export const command = 0x93d4;
  export const subCommand = 1;
  export const reqSchema = DOWNLOAD_URL_REQ;
  export const respSchema = DOWNLOAD_URL_RESP;

  export interface Params {
    filesetUuid: string;
  }

  export const serialize = (p: Params): Record<string, unknown> => ({
    filesetUuid: p.filesetUuid,
    inner: {
      field1: '',
      field2: 1,
      field3: 18,
      field4: '',
      field5: { field1: 0 },
      field6: { field1: 0, field2: 0 },
    },
    field3: 7,
    field4: 1,
  });

  export const deserialize = (body: Record<string, unknown>): FlashDownloadFileMeta[] => {
    const entry = body.entry as Record<string, unknown> | undefined;
    const infos = (entry?.fileInfo as Record<string, unknown>[] | undefined) ?? [];
    return infos.map((info, index) => {
      const main = info.mainFile as Record<string, unknown> | undefined;
      return {
        fileIndex: typeof info.field6 === 'number' ? info.field6 : index + 1,
        fileId: typeof main?.fileId === 'string' ? main.fileId : '',
        filesetUuid: typeof info.filesetUuid === 'string' ? info.filesetUuid : '',
        fileUuid: typeof info.fileUuid === 'string' ? info.fileUuid : '',
        fileName: typeof info.fileName === 'string' ? info.fileName : '',
        fileSize:
          typeof info.fileSize === 'bigint'
            ? Number(info.fileSize)
            : typeof info.fileSize === 'number'
              ? info.fileSize
              : 0,
      };
    });
  };

  export const invoke = (
    nt: OidbNative,
    pid: number,
    params: Params,
  ): Promise<FlashDownloadFileMeta[]> =>
    invokeOidb(nt, pid, GetFlashDownloadUrl as OidbSpec<Params, FlashDownloadFileMeta[]>, params);
}

// ───────────────────────── 0x12A9_200 ─────────────────────────

const GET_DOWNLOAD_WRAPPER = message([
  { name: 'fileInfo', tag: 1, type: FLASH_APPLY_FILE_INFO },
  { name: 'fileId', tag: 2, type: 'string' },
  { name: 'field3', tag: 3, type: 'uint32' },
  { name: 'field4', tag: 4, type: 'uint32' },
  { name: 'field5', tag: 5, type: 'uint32' },
  { name: 'field6', tag: 6, type: 'uint32' },
]);

const GET_DOWNLOAD_F2 = message([
  { name: 'field1', tag: 1, type: 'uint32' },
  { name: 'field3', tag: 3, type: 'uint32' },
  { name: 'field5', tag: 5, type: 'uint32' },
  { name: 'field6', tag: 6, type: DOWNLOAD_URL_REQ_INNER5 },
]);

const GET_DOWNLOAD_F2_WRAP = message([
  { name: 'field2', tag: 2, type: GET_DOWNLOAD_F2 },
  { name: 'field4', tag: 4, type: DOWNLOAD_URL_REQ_INNER5 },
  { name: 'filesetWrap', tag: 3, type: FLASH_APPLY_FILESET_WRAP },
]);

const GET_DOWNLOAD_PAYLOAD = message([
  { name: 'wrapper', tag: 1, type: GET_DOWNLOAD_WRAPPER },
  { name: 'field2', tag: 2, type: GET_DOWNLOAD_F2_WRAP },
  { name: 'field3', tag: 3, type: 'uint32' },
]);

const GET_DOWNLOAD_REQ = message([
  { name: 'head', tag: 1, type: FLASH_APPLY_HEAD },
  { name: 'payload', tag: 3, type: GET_DOWNLOAD_PAYLOAD },
]);

const GET_DOWNLOAD_RESP = message([
  { name: 'head', tag: 1, type: FLASH_APPLY_HEAD_RESP },
  { name: 'body', tag: 3, type: 'bytes' },
]);

export interface FlashDownloadParams {
  filesetUuid: string;
  fileUuid: string;
  fileId: string;
  fileName: string;
}

export namespace GetFlashDownload {
  export const command = 0x12a9;
  export const subCommand = 200;
  export const reqSchema = GET_DOWNLOAD_REQ;
  export const respSchema = GET_DOWNLOAD_RESP;

  export const serialize = (p: FlashDownloadParams): Record<string, unknown> => ({
    head: {
      sub: { seq: nextUploadSeq(), sub: 200 },
      config: { field101: 2, field102: 4, field103: 22, field200: 5 },
      field3: { field1: 1 },
    },
    payload: {
      wrapper: {
        fileInfo: {
          fileSize: 0,
          md5: '',
          sha1: '',
          fileName: p.fileName,
          field5: { field1: 0, field2: 0, field3: 0, field4: 0 },
          field6: 0,
          field7: 0,
          field8: 0,
          field9: 0,
        },
        fileId: p.fileId,
        field3: 0,
        field4: 0,
        field5: 0,
        field6: 0,
      },
      field2: {
        field2: { field1: 0, field3: 0, field5: 0, field6: { field1: 0 } },
        field4: { field1: 0 },
        filesetWrap: {
          filesetUuid: p.filesetUuid,
          fileUuid: p.fileUuid,
          field3: 26,
          field4: p.fileUuid,
        },
      },
      field3: 0,
    },
  });

  export const deserialize = (body: Record<string, unknown>): string | null => {
    const bytes = body.body;
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) return null;
    const text = Buffer.from(bytes).toString('latin1');
    const host = /multimedia\.qfile\.qq\.com/.exec(text);
    const path = /\/download\?appid=14901[\x20-\x7e]*/.exec(text);
    if (!host || !path) return null;
    const base = `https://${host[0]}${path[0]}`;
    const rkey = /rkey=([A-Za-z0-9_-]+)/.exec(text);
    return rkey ? `${base}&${rkey[0]}` : base;
  };

  export const invoke = (
    nt: OidbNative,
    pid: number,
    params: FlashDownloadParams,
  ): Promise<string | null> =>
    invokeOidb(nt, pid, GetFlashDownload as OidbSpec<FlashDownloadParams, string | null>, params);
}
