/**
 * 系统推送去重。
 *
 * QQ NT 的 `sys_msg_mgr.cc::ProcessRecvSysMsg` 在把系统消息交给上层之前会按
 * `{peer}_{chatType}_{msg_seq}_{random}` 去重；同一帧既走 `MsgPush` 又被
 * 别的通道重放时，bot 会看到两次「入群申请 / 戳一戳 / 撤回」。这里镜像同一张
 * 路由表，只对**已确认**的 `(msgType, subType)` 组合生效；未知组合 fail-open
 * （宁可得两次，也不能误删两条无关事件）。
 *
 * 群聊的 peer 用 `fromUin`（群号），C2C 用 `fromUid`；`random` 用 `msgId`，
 * 与 QQ 的 contentHead 字段 4 对应。
 */

import type { RawMessageBody } from '../msg/decode';

type ChatType = 1 | 2;

interface SysMsgIdentity {
  peer: string;
  chatType: ChatType;
  sequence: number;
  random: number;
}

function chatTypeOf(msgType: number, subType: number): ChatType | null {
  if (msgType === 528 && subType === 290) return 1;
  if (
    msgType === 166 &&
    (subType === 75 || subType === 129 || subType === 131 || subType === 133 || subType === 135)
  ) {
    return 1;
  }
  if (msgType === 167 && subType === 133) return 1;
  if (msgType === 732 && (subType === 12 || subType === 16 || subType === 20)) return 2;
  if ((msgType === 33 || msgType === 34 || msgType === 85) && subType === 0) return 2;
  return null;
}

function identityOf(raw: RawMessageBody): SysMsgIdentity | null {
  const head = raw.contentHead;
  if (!head) return null;
  const msgType = head.msgType ?? 0;
  const subType = head.subType ?? 0;
  const chatType = chatTypeOf(msgType, subType);
  const sequence = head.sequence ?? 0;
  const random = head.msgId ?? 0;
  if (chatType === null || sequence === 0 || random === 0) return null;

  const fromUin = raw.responseHead?.fromUin ?? 0;
  const fromUid = raw.responseHead?.fromUid ?? '';
  const peer = chatType === 1 ? fromUid : String(fromUin);
  if (!peer || (chatType === 2 && fromUin === 0)) return null;

  return { peer, chatType, sequence, random };
}

export class SysMsgDedup {
  private readonly seen = new Set<string>();
  private readonly ring: (string | undefined)[];
  private cursor = 0;

  constructor(private readonly capacity = 1024) {
    this.ring = new Array<string | undefined>(capacity);
  }

  /** 这条系统推送是否已经见过（第一次见返回 `false`）。 */
  seenDuplicate(raw: RawMessageBody): boolean {
    const identity = identityOf(raw);
    if (!identity) return false;

    const key = `${identity.peer}_${identity.chatType}_${identity.sequence}_${identity.random}`;
    if (this.seen.has(key)) return true;

    const evicted = this.ring[this.cursor];
    if (evicted !== undefined) this.seen.delete(evicted);
    this.ring[this.cursor] = key;
    this.seen.add(key);
    this.cursor = (this.cursor + 1) % this.capacity;
    return false;
  }
}
