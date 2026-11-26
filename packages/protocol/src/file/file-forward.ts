import { sendC2cFileMessage } from '../msg/send';
import { FILE_EXTRA } from '../msg/schemas';
import { invokeOidb, type OidbSpec } from '../oidb/invoke';
import { encode, message } from '../protobuf';
import type { OidbNative } from '../transport';
import { publishGroupFile, type FileNative } from './file-send';

export interface ForwardFileSource {
  fileId: string;
  fileName: string;
  fileSize: number;
  md5Hex?: string;
  sha1Hex?: string;
  fileHash?: string;
  groupId?: number;
  busId?: number;
}

export type ForwardFileTarget = { groupId: number } | { userUid: string };

export interface ForwardedFile {
  fileId: string;
  fileName: string;
  fileSize: number;
  md5Hex?: string;
  sha1Hex?: string;
  fileHash?: string;
  busId?: number;
}

// QQNT macOS 7.0.3-54395: C2CForwardToC2COp (0x169a638) and
// C2CForwardToOtherOp (0x169d230). Both return a newly scoped file reference.
const privateHead = [
  { name: 'command', tag: 1, type: 'uint32' },
  { name: 'seq', tag: 2, type: 'int32' },
  { name: 'businessId', tag: 101, type: 'int32' },
  { name: 'clientType', tag: 102, type: 'int32' },
  { name: 'mediaPlatform', tag: 200, type: 'int32' },
] as const;

function privateForwardSpec<T>(
  command: number,
  tag: number,
  req: ReturnType<typeof message>,
  resp: ReturnType<typeof message>,
): OidbSpec<T, { fileId: string; fileHash?: string; busId?: number }> {
  return {
    command: 0xe37,
    subCommand: command,
    reqSchema: message([...privateHead, { name: 'copy', tag, type: req }]),
    respSchema: message([{ name: 'copy', tag, type: resp }]),
    serialize: (copy) => ({
      command,
      seq: 0,
      businessId: 3,
      clientType: 103,
      mediaPlatform: 1,
      copy,
    }),
    deserialize: (body) => readCopy(body.copy),
  };
}

const CopyPrivateToPrivate = privateForwardSpec<{
  selfUid: string;
  userUid: string;
  fileId: string;
}>(
  700,
  9,
  message([
    { name: 'selfUid', tag: 10, type: 'string' },
    { name: 'userUid', tag: 20, type: 'string' },
    { name: 'fileId', tag: 30, type: 'string' },
  ]),
  message([
    { name: 'retCode', tag: 10, type: 'int32' },
    { name: 'retMsg', tag: 20, type: 'string' },
    { name: 'fileId', tag: 50, type: 'string' },
    { name: 'fileHash', tag: 60, type: 'string' },
  ]),
);

const CopyPrivateToGroup = privateForwardSpec<{
  groupId: number;
  busId: number;
  selfUid: string;
  fileSize: number;
  fileName: string;
  fileId: string;
}>(
  60100,
  90000,
  message([
    { name: 'groupId', tag: 10, type: 'uint64' },
    { name: 'busId', tag: 30, type: 'uint32' },
    { name: 'selfUid', tag: 40, type: 'string' },
    { name: 'fileSize', tag: 50, type: 'uint64' },
    { name: 'fileName', tag: 60, type: 'string' },
    { name: 'fileId', tag: 80, type: 'string' },
  ]),
  message([
    { name: 'retCode', tag: 10, type: 'int32' },
    { name: 'retMsg', tag: 20, type: 'string' },
    { name: 'fileId', tag: 30, type: 'string' },
    { name: 'busId', tag: 50, type: 'uint32' },
  ]),
);

// GroupForwardOp (0x169e334 / 0x169ec28): tag 3 contains the group copy request and response.
const groupCopyFields = [
  { name: 'groupId', tag: 1, type: 'uint64' },
  { name: 'appId', tag: 2, type: 'uint32' },
  { name: 'busId', tag: 3, type: 'uint32' },
  { name: 'fileId', tag: 4, type: 'string' },
  { name: 'targetBusId', tag: 5, type: 'uint32' },
] as const;

function copyGroupSpec(toGroup: boolean) {
  return {
    command: 0x6d9,
    subCommand: 2,
    reqSchema: message([
      {
        name: 'copy',
        tag: 3,
        type: message([
          ...groupCopyFields,
          { name: 'targetId', tag: 6, type: toGroup ? 'uint64' : 'string' },
        ]),
      },
    ]),
    respSchema: message([
      {
        name: 'copy',
        tag: 3,
        type: message([
          { name: 'retCode', tag: 1, type: 'int32' },
          { name: 'retMsg', tag: 2, type: 'string' },
          { name: 'wording', tag: 3, type: 'string' },
          { name: 'fileId', tag: 4, type: 'string' },
          { name: 'busId', tag: 5, type: 'uint32' },
        ]),
      },
    ]),
    serialize: ({
      groupId,
      busId,
      fileId,
      target,
    }: {
      groupId: number;
      busId: number;
      fileId: string;
      target: ForwardFileTarget;
    }) => ({
      copy: {
        groupId,
        appId: 1,
        busId,
        fileId,
        targetBusId: 'groupId' in target ? 102 : 3,
        targetId: 'groupId' in target ? target.groupId : target.userUid,
      },
    }),
    deserialize: (body: Record<string, unknown>) => readCopy(body.copy),
  };
}

function readCopy(value: unknown): { fileId: string; fileHash?: string; busId?: number } {
  const copy = value as
    | {
        retCode?: number;
        retMsg?: string;
        wording?: string;
        fileId?: string;
        fileHash?: string;
        busId?: number;
      }
    | undefined;
  if (!copy) throw new Error('QQ 未返回文件转存结果');
  if (copy.retCode)
    throw new Error(copy.wording || copy.retMsg || `QQ 拒绝转存（${copy.retCode}）`);
  if (!copy.fileId?.trim()) throw new Error('QQ 未返回目标文件标识');
  return { fileId: copy.fileId, fileHash: copy.fileHash, busId: copy.busId };
}

/** Prepare a target reference without uploading bytes or posting a message. */
export async function copyForwardFile(
  nt: OidbNative,
  pid: number,
  source: ForwardFileSource,
  selfUid: string,
  target: ForwardFileTarget,
): Promise<ForwardedFile> {
  if (
    !source.fileId ||
    !source.fileName ||
    !Number.isSafeInteger(source.fileSize) ||
    source.fileSize < 0
  )
    throw new Error('原文件缺少转发所需的信息');
  const copied = source.groupId
    ? await invokeOidb(nt, pid, copyGroupSpec('groupId' in target), {
        groupId: source.groupId,
        busId: source.busId ?? 102,
        fileId: source.fileId,
        target,
      })
    : 'groupId' in target
      ? await invokeOidb(nt, pid, CopyPrivateToGroup, {
          ...source,
          selfUid,
          groupId: target.groupId,
          busId: 102,
        })
      : await invokeOidb(nt, pid, CopyPrivateToPrivate, {
          selfUid,
          userUid: target.userUid,
          fileId: source.fileId,
        });
  return {
    fileId: copied.fileId,
    fileName: source.fileName,
    fileSize: source.fileSize,
    md5Hex: source.md5Hex,
    sha1Hex: source.sha1Hex,
    ...('groupId' in target
      ? { busId: copied.busId || 102 }
      : { fileHash: copied.fileHash || source.fileHash || source.md5Hex || '' }),
  };
}

export function encodePrivateForwardedFile(file: ForwardedFile): Uint8Array {
  return encode(FILE_EXTRA, {
    file: {
      fileType: 0,
      fileUuid: file.fileId,
      fileMd5: Buffer.from(file.md5Hex ?? '', 'hex'),
      fileName: file.fileName,
      fileSize: BigInt(file.fileSize),
      subcmd: 1,
      dangerEvel: 0,
      expireTime: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
      fileHash: file.fileHash,
    },
  });
}

/** Publish only after a target reference has been prepared. Do not retry on unknown receipts. */
export async function publishForwardedFile(
  nt: FileNative,
  pid: number,
  target: ForwardFileTarget,
  file: ForwardedFile,
) {
  if ('groupId' in target) {
    await publishGroupFile(nt, pid, {
      groupId: target.groupId,
      fileId: file.fileId,
      busId: file.busId,
    });
    return { ok: true, fileId: file.fileId };
  }
  const receipt = await sendC2cFileMessage(nt, pid, {
    userUid: target.userUid,
    fileExtra: encodePrivateForwardedFile(file),
  });
  return {
    ok: receipt.ok,
    errMsg: receipt.errMsg,
    fileId: file.fileId,
    result: receipt.result,
    privateSequence: receipt.privateSequence,
    random: receipt.random,
  };
}
