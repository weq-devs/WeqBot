import { decode } from '../protobuf';
import { PUSH_MSG_BODY } from '../msg/schemas';
import type { RawMessageBody } from '../msg/decode';
import { FRIEND_RECALL, GROUP_NOTIFY_BODY } from '../push/schemas';
import { filterProtoBytes } from '../msg/dump';

export interface RecallTarget {
  kind: 'c2c' | 'group';
  conv: string;
  senderUid: string;
  revokeUid: string;
  sequence?: number;
  clientSequence?: number;
  messageUid?: string;
  timestamp?: number;
}

/** 明确完整的撤回身份才交给过滤器；异常/未知通知继续转发。 */
export function decodeRecallTargets(raw: RawMessageBody, selfUid: string): RecallTarget[] {
  const head = raw.contentHead;
  const content = raw.body?.msgContent;
  if (!head || !content) return [];
  if (head.msgType === 528 && (head.subType === 138 || head.subType === 139)) {
    const { info } = decode(FRIEND_RECALL, content) as {
      info?: {
        fromUid?: string;
        toUid?: string;
        clientSequence?: number;
        newId?: bigint;
        time?: number;
      };
    };
    if (!info?.fromUid || !info.toUid || !info.clientSequence || !info.time) return [];
    if (info.fromUid !== selfUid && info.toUid !== selfUid) return [];
    return [
      {
        kind: 'c2c',
        conv: info.fromUid === selfUid ? info.toUid : info.fromUid,
        senderUid: info.fromUid,
        revokeUid: info.fromUid,
        clientSequence: info.clientSequence,
        timestamp: info.time,
        ...(info.newId && info.newId > 0n ? { messageUid: String(info.newId) } : {}),
      },
    ];
  }
  if (head.msgType !== 732 || head.subType !== 17 || content.length < 7) return [];
  const size = (content[5]! << 8) | content[6]!;
  if (size !== content.length - 7) return [];
  const notify = decode(GROUP_NOTIFY_BODY, content.subarray(7)) as {
    groupUin?: number;
    operatorUid?: string;
    recall?: { operatorUid?: string; recallMessages?: { sequence?: number; authorUid?: string }[] };
  };
  const group = notify.groupUin || raw.responseHead?.grp?.groupUin;
  const operator = notify.recall?.operatorUid || notify.operatorUid;
  const messages = notify.recall?.recallMessages;
  if (!group || !operator || !messages?.length || messages.some((m) => !m.sequence || !m.authorUid))
    return [];
  return messages.map((m) => ({
    kind: 'group',
    conv: String(group),
    senderUid: m.authorUid!,
    revokeUid: operator,
    sequence: m.sequence!,
  }));
}

export interface ObservedPush {
  raw: string;
  recalls: RecallTarget[];
}

/** 一次只移除目标完整的撤回子消息，其他子消息按原始字节保留。 */
export function inspectRecallPush(
  body: Uint8Array,
  selfUid: string,
  protect: (target: RecallTarget) => boolean,
  block: boolean,
) {
  const observed: ObservedPush[] = [];
  let removed = 0;
  const filtered = filterProtoBytes(body, 1, (bytes) => {
    try {
      const raw = decode(PUSH_MSG_BODY, bytes) as RawMessageBody;
      const recalls = decodeRecallTargets(raw, selfUid);
      const group = raw.responseHead?.grp?.groupUin;
      const sender = raw.responseHead?.fromUid ?? '';
      const peer = group ? String(group) : sender === selfUid ? raw.responseHead?.toUid : sender;
      const isMessage = [82, 166, 167, 141].includes(raw.contentHead?.msgType ?? 0);
      if (
        (recalls.length && recalls.some(protect)) ||
        (isMessage &&
          peer &&
          protect({
            kind: group ? 'group' : 'c2c',
            conv: peer,
            senderUid: sender,
            revokeUid: '',
          }))
      )
        observed.push({ raw: Buffer.from(bytes).toString('base64'), recalls });
      if (block && recalls.length && recalls.every(protect)) {
        removed++;
        return false;
      }
    } catch {
      /* 单条未知事件按原字节通过。 */
    }
    return true;
  });
  return { body: Buffer.from(filtered), observed, removed };
}
