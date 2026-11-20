import { randomBytes } from 'node:crypto';
import { decode, encode, message } from '../protobuf';
import { decodePushEnvelope } from '../push/decode';
import type { ReadReportParams } from '../msg/report-read';
export * from './frame';
export * from './recall';

export const MSG_PUSH_COMMAND = 'trpc.msg.olpush.OlPushService.MsgPush';
const rawEnvelope = message([{ name: 'messages', tag: 1, type: 'bytes', repeated: true }]);
const groupRead = message([
  { name: 'group', tag: 1, type: 'uint64' },
  { name: 'sequence', tag: 4, type: 'uint64' },
]);
const privateRead = message([
  {
    name: 'peers',
    tag: 1,
    repeated: true,
    type: message([
      { name: 'uid', tag: 1, type: 'string' },
      { name: 'time', tag: 2, type: 'uint32' },
      { name: 'sequence', tag: 20, type: 'uint64' },
    ]),
  },
]);
const officialRead = message([
  {
    name: 'peers',
    tag: 1,
    repeated: true,
    type: message([
      { name: 'uid', tag: 1, type: 'string' },
      { name: 'time', tag: 2, type: 'uint32' },
      { name: 'reserved9', tag: 9, type: 'uint32', force: true },
      { name: 'reserved11', tag: 11, type: 'uint32', force: true },
      { name: 'sequence', tag: 20, type: 'uint64', force: true },
      { name: 'reserved21', tag: 21, type: 'uint32', force: true },
    ]),
  },
]);
const head = message([
  { name: 'type', tag: 1, type: 'uint32' },
  { name: 'subtype', tag: 2, type: 'uint32' },
  { name: 'c2cCmd', tag: 3, type: 'uint32' },
  { name: 'random', tag: 4, type: 'uint32' },
  { name: 'sequence', tag: 5, type: 'uint32' },
  { name: 'time', tag: 6, type: 'uint32' },
]);
const routing = message([
  { name: 'fromUin', tag: 1, type: 'uint64' },
  { name: 'fromUid', tag: 2, type: 'string' },
  { name: 'toUin', tag: 5, type: 'uint64' },
  { name: 'toUid', tag: 6, type: 'string' },
]);
const systemMessage = message([
  { name: 'routing', tag: 1, type: routing },
  { name: 'head', tag: 2, type: head },
  { name: 'body', tag: 3, type: message([{ name: 'content', tag: 2, type: 'bytes' }]) },
]);

export type ClientReadTarget = ReadReportParams;

/** 原始消息体保留服务端未知字段。 */
export function wrapClientMessage(raw: Uint8Array): Buffer {
  return Buffer.from(encode(rawEnvelope, { messages: [raw] }));
}

/** 普通私聊 528/8、群聊 732/1，与 QQNT 原生判断函数和手机样本一致。 */
export function buildClientReadNotify(
  self: { uin: string; uid: string },
  target: ClientReadTarget,
): Buffer {
  if (
    !Number.isSafeInteger(target.sequence) ||
    (target.kind === 'official' ? target.sequence !== 0 : target.sequence <= 0) ||
    target.sequence > 0xffffffff
  )
    throw new Error('已读位置无效');
  if (target.kind === 'group' && (!Number.isSafeInteger(target.groupUin) || target.groupUin <= 0))
    throw new Error('群标识无效');
  if (
    target.kind !== 'group' &&
    (!target.targetUid.startsWith('u_') ||
      !Number.isSafeInteger(target.timestamp) ||
      target.timestamp <= 0 ||
      (target.kind === 'official' && target.timestamp > 0xffffffff))
  )
    throw new Error('私聊已读身份无效');
  const content =
    target.kind === 'group'
      ? encode(groupRead, { group: BigInt(target.groupUin), sequence: BigInt(target.sequence) })
      : encode(target.kind === 'official' ? officialRead : privateRead, {
          peers: [
            {
              uid: target.targetUid,
              time: target.timestamp,
              sequence: BigInt(target.sequence),
              ...(target.kind === 'official' ? { reserved9: 0, reserved11: 0, reserved21: 0 } : {}),
            },
          ],
        });
  const identity = randomBytes(4).readUInt32BE() || 1;
  return wrapClientMessage(
    encode(systemMessage, {
      routing: {
        fromUin: target.kind === 'group' ? BigInt(target.groupUin) : BigInt(self.uin),
        fromUid: target.kind !== 'group' ? self.uid : undefined,
        toUin: BigInt(self.uin),
        toUid: self.uid,
      },
      head: {
        type: target.kind === 'group' ? 732 : 528,
        subtype: target.kind === 'group' ? 1 : 8,
        c2cCmd: target.kind === 'official' ? 8 : undefined,
        random: identity,
        sequence: identity,
        time: Math.floor(Date.now() / 1000),
      },
      body: { content },
    }),
  );
}

/** 用于目标客户端已读确认，解析真正收到的推送也能复用。 */
export function clientReadTargets(body: Uint8Array): ClientReadTarget[] {
  const out: ClientReadTarget[] = [];
  for (const msg of decodePushEnvelope(body).messages) {
    const bytes = msg.body?.msgContent;
    if (!bytes) continue;
    if (msg.contentHead?.msgType === 732 && msg.contentHead.subType === 1) {
      const value = decode(groupRead, bytes);
      out.push({ kind: 'group', groupUin: Number(value.group), sequence: Number(value.sequence) });
    }
    if (msg.contentHead?.msgType === 528 && msg.contentHead.subType === 8) {
      const value = decode(privateRead, bytes);
      for (const item of (value.peers ?? []) as Record<string, unknown>[])
        out.push(
          Number(item.sequence) === 0
            ? {
                kind: 'official',
                targetUid: String(item.uid),
                timestamp: Number(item.time),
                sequence: 0,
              }
            : {
                kind: 'c2c',
                targetUid: String(item.uid),
                timestamp: Number(item.time),
                sequence: Number(item.sequence),
              },
        );
    }
  }
  return out;
}
