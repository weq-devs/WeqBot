/**
 * 0x6D9_0 — 把临时群文件转存到永久群文件。
 *
 * 搬运自 SnowLuma `oidb-services/group-file/trans-group-file.ts`（2026-11-15），
 * 改为 WeqBot 的 `message()` schema 写法。
 *
 * 签名：0x6D9_0 不在 SIGN_RULES（0x6D9_4 是另一条命令），三端待实测。
 */

import { message } from '../../protobuf';
import { invokeOidb, type OidbSpec } from '../invoke';
import { ensureRetCodeZero, toInt } from '../shared';
import type { OidbNative } from '../../transport';

const TRANS_FILE = message([
  { name: 'groupUin', tag: 1, type: 'uint64' },
  { name: 'appId', tag: 2, type: 'uint32' },
  { name: 'busId', tag: 3, type: 'uint32' },
  { name: 'fileId', tag: 4, type: 'string' },
]);

const TRANS_REQ = message([{ name: 'transFile', tag: 1, type: TRANS_FILE }]);

const TRANS_RESULT = message([
  { name: 'retCode', tag: 1, type: 'int32' },
  { name: 'retMsg', tag: 2, type: 'string' },
  { name: 'clientWording', tag: 3, type: 'string' },
  { name: 'saveBusId', tag: 4, type: 'uint32' },
  { name: 'saveFilePath', tag: 5, type: 'string' },
]);

const TRANS_RESP = message([{ name: 'transFile', tag: 1, type: TRANS_RESULT }]);

export interface TransGroupFileResult {
  saveBusId: number;
  saveFilePath: string;
}

export interface TransGroupFileParams {
  groupId: number;
  fileId: string;
}

export namespace TransGroupFile {
  export const command = 0x6d9;
  export const subCommand = 0;
  export const reqSchema = TRANS_REQ;
  export const respSchema = TRANS_RESP;

  export type Params = TransGroupFileParams;

  export const serialize = (p: Params): Record<string, unknown> => {
    if (!Number.isSafeInteger(p.groupId) || p.groupId <= 0) {
      throw new Error(`groupUin 必须是正整数，收到 ${String(p.groupId)}`);
    }
    const fileId = String(p.fileId ?? '').trim();
    if (!fileId) throw new Error('fileId 不能为空');
    return {
      transFile: { groupUin: BigInt(p.groupId), appId: 7, busId: 102, fileId },
    };
  };

  export const deserialize = (body: Record<string, unknown>): TransGroupFileResult => {
    const result = body.transFile as Record<string, unknown> | undefined;
    if (!result) throw new Error('群文件转存回包缺少 transFile');
    ensureRetCodeZero(
      '群文件转存',
      toInt(result.retCode),
      typeof result.retMsg === 'string' ? result.retMsg : '',
      typeof result.clientWording === 'string' ? result.clientWording : '',
    );
    return {
      saveBusId: toInt(result.saveBusId),
      saveFilePath: typeof result.saveFilePath === 'string' ? result.saveFilePath : '',
    };
  };

  export const invoke = (
    nt: OidbNative,
    pid: number,
    params: Params,
  ): Promise<TransGroupFileResult> =>
    invokeOidb(nt, pid, TransGroupFile as OidbSpec<Params, TransGroupFileResult>, params);
}
