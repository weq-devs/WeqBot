/**
 * `MsgPush` 的业务分派。
 *
 * 一帧 `MsgPush` 里可能混着聊天消息、系统通知、好友申请；`decode.ts` 只负责
 * 拆壳，本文件按 `PkgType`（`contentHead.msgType`）查表分派，再按子类型细化。
 *
 * **只做 wire → 语义**：这里没有 uin ↔ uid 的映射（那需要会话上下文，见
 * `@weqbot/session` 的 `IdentityCache`），也不做 OneBot 词汇。
 *
 * 新增推送类型的顺序：先在 `types.ts` 加事件形状，再在这里注册一个
 * `(raw) => event | null`，最后补一条合成帧单测。没注册的类型会落成
 * `kind: 'system'`，保留原始字节，不丢数据也不猜 schema。
 */

import { decode } from '../protobuf';
import type { RawMessageBody } from '../msg/decode';
import {
  FRIEND_RECALL,
  FRIEND_REQUEST,
  GENERAL_GRAY_TIP,
  GROUP_ADMIN,
  GROUP_CHANGE,
  GROUP_CHANGE_OPERATOR,
  GROUP_INVITE,
  GROUP_INVITATION,
  GROUP_JOIN,
  GROUP_MUTE,
  GROUP_NOTIFY_BODY,
  GROUP_REACT,
  INPUT_STATUS_NOTIFY,
  NEW_FRIEND,
  SELF_JOIN_GROUP,
} from './schemas';
import type {
  PushEvent,
  PushFriendAddEvent,
  PushFriendRecallEvent,
  PushFriendRequestEvent,
  PushGroupAdminEvent,
  PushGroupEssenceEvent,
  PushGroupMemberEvent,
  PushGroupMuteEvent,
  PushGroupReactionEvent,
  PushGroupRecallEvent,
  PushGroupRequestEvent,
  PushInputStatusEvent,
  PushPokeEvent,
  PushSystemEvent,
} from './types';

export type PushDecoder = (raw: RawMessageBody) => PushEvent | null;

/** 0x2dc 的子类型；消息里没有独立字段，只能靠 `contentHead.subType`。 */
const SUBTYPE_GROUP_MUTE = 12;
const SUBTYPE_GROUP_REACTION = 16;
const SUBTYPE_GROUP_RECALL = 17;
const SUBTYPE_GROUP_GRAY_TIP = 20;
const SUBTYPE_GROUP_ESSENCE = 21;

/** 0x2dc/16 的 `NotifyMessageBody.field13` 判别值。 */
const FIELD13_EMOJI_REACT = 35;

const SUBTYPE_FRIEND_REQUEST = 35;
const SUBTYPE_FRIEND_RECALL = 138;
const SUBTYPE_FRIEND_RECALL_SELF = 139;
const SUBTYPE_NEW_FRIEND = 179;
const SUBTYPE_NEW_FRIEND_ALT = 226;
const SUBTYPE_INPUT_STATUS = 277;
const SUBTYPE_POKE = 290;

/** 0x2dc 的 content 前 7 字节是壳。 */
const GROUP_NOTIFY_PREFIX = 7;

/** 推一戳 / 群灰条共用的 busiType。 */
const GRAY_TIP_POKE_BUSI_TYPE = 12n;

type Lookup = (msgType: number, subType: number) => PushDecoder | undefined;

export class MsgPushRegistry {
  private readonly decoders = new Map<number, PushDecoder>();

  constructor(private readonly lookup?: Lookup) {}

  register(msgType: number | readonly number[], decoder: PushDecoder): this {
    for (const type of typeof msgType === 'number' ? [msgType] : msgType) {
      if (this.decoders.has(type)) {
        throw new Error(`MsgPushRegistry: msgType ${type} already registered`);
      }
      this.decoders.set(type, decoder);
    }
    return this;
  }

  /** 没有解码器（或解码抛错）时返回 `null`，由调用方落成 `system`。 */
  decode(raw: RawMessageBody): PushEvent | null {
    const msgType = raw.contentHead?.msgType ?? 0;
    const subType = raw.contentHead?.subType ?? 0;
    try {
      return (this.lookup?.(msgType, subType) ?? this.decoders.get(msgType))?.(raw) ?? null;
    } catch {
      return null;
    }
  }
}

// ─────────────────────────── helpers ───────────────────────────

function head(raw: RawMessageBody) {
  return {
    time: raw.contentHead?.timestamp ?? 0,
    msgType: raw.contentHead?.msgType ?? 0,
    subType: raw.contentHead?.subType ?? 0,
    content: raw.body?.msgContent ?? new Uint8Array(0),
    fromUin: raw.responseHead?.fromUin ?? 0,
    fromUid: raw.responseHead?.fromUid ?? '',
    groupUin: raw.responseHead?.grp?.groupUin ?? 0,
  };
}

function system(raw: RawMessageBody): PushSystemEvent {
  const h = head(raw);
  return {
    kind: 'system',
    msgType: h.msgType,
    subType: h.subType,
    time: h.time,
    fromUin: h.fromUin,
    fromUid: h.fromUid,
    toUin: raw.responseHead?.toUin ?? 0,
    groupUin: h.groupUin,
    content: h.content,
  };
}

function asUid(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return 0;
}

/** `GroupChange.operatorBytes`：裸 uid 或 `OperatorInfo` 都见过。 */
function decodeOperator(raw: Uint8Array | undefined, allowRaw: boolean): string {
  if (!raw || raw.length === 0) return '';
  const text = new TextDecoder().decode(raw);
  if (allowRaw && /^u_[A-Za-z0-9_-]+$/.test(text)) return text;
  try {
    return asUid(
      (decode(GROUP_CHANGE_OPERATOR, raw) as { operatorField?: { uid?: string } }).operatorField
        ?.uid,
    );
  } catch {
    return '';
  }
}

function unwrapGroupNotify(content: Uint8Array): Uint8Array | null {
  if (content.length <= GROUP_NOTIFY_PREFIX) return null;
  const lenBe = (content[5]! << 8) | content[6]!;
  const lenLe = content[5]! | (content[6]! << 8);
  if (GROUP_NOTIFY_PREFIX + lenBe <= content.length) {
    return content.subarray(GROUP_NOTIFY_PREFIX, GROUP_NOTIFY_PREFIX + lenBe);
  }
  if (GROUP_NOTIFY_PREFIX + lenLe <= content.length) {
    return content.subarray(GROUP_NOTIFY_PREFIX, GROUP_NOTIFY_PREFIX + lenLe);
  }
  return content.subarray(GROUP_NOTIFY_PREFIX);
}

// ─────────────────────────── 0x210 ───────────────────────────

function decode0x210(raw: RawMessageBody): PushEvent | null {
  const h = head(raw);

  if (h.subType === SUBTYPE_INPUT_STATUS) {
    try {
      const notify = decode(INPUT_STATUS_NOTIFY, h.content) as {
        fromUid?: string;
        toUid?: string;
        notifyItem?: { eventType?: number; statusText?: string };
      };
      if (!notify.fromUid) return system(raw);
      const eventType = notify.notifyItem?.eventType ?? 1;
      return {
        kind: 'input-status',
        time: h.time,
        fromUid: notify.fromUid,
        toUid: notify.toUid ?? '',
        eventType,
        text:
          notify.notifyItem?.statusText ??
          (eventType === 3 ? '对方正在讲话...' : '对方正在输入...'),
      } satisfies PushInputStatusEvent;
    } catch {
      return system(raw);
    }
  }

  if (h.subType === SUBTYPE_FRIEND_RECALL || h.subType === SUBTYPE_FRIEND_RECALL_SELF) {
    try {
      const recall = decode(FRIEND_RECALL, h.content) as {
        info?: { fromUid?: string; toUid?: string; clientSequence?: number; time?: number };
      };
      if (!recall.info) return system(raw);
      return {
        kind: 'friend-recall',
        time: recall.info.time ?? h.time,
        fromUid: recall.info.fromUid ?? '',
        toUid: recall.info.toUid ?? '',
        clientSequence: recall.info.clientSequence ?? 0,
        recalledBySelf: h.subType === SUBTYPE_FRIEND_RECALL_SELF,
      } satisfies PushFriendRecallEvent;
    } catch {
      return system(raw);
    }
  }

  if (h.subType === SUBTYPE_FRIEND_REQUEST) {
    try {
      const request = decode(FRIEND_REQUEST, h.content) as {
        info?: {
          targetUid?: string;
          sourceUid?: string;
          newSource?: string;
          message?: string;
        };
      };
      const fromUid = asUid(request.info?.newSource) || asUid(request.info?.sourceUid);
      if (!fromUid) return system(raw);
      return {
        kind: 'friend-request',
        time: h.time,
        fromUid,
        targetUid: asUid(request.info?.targetUid),
        message: asUid(request.info?.message),
        flag: fromUid,
      } satisfies PushFriendRequestEvent;
    } catch {
      return system(raw);
    }
  }

  if (h.subType === SUBTYPE_NEW_FRIEND || h.subType === SUBTYPE_NEW_FRIEND_ALT) {
    try {
      const notify = decode(NEW_FRIEND, h.content) as {
        info?: { uid?: string; toUid?: string; nickName?: string; time?: number };
      };
      const uid = asUid(notify.info?.uid);
      if (!uid) return system(raw);
      return {
        kind: 'friend-add',
        time: notify.info?.time || h.time,
        uid,
        toUid: asUid(notify.info?.toUid),
        nickname: asUid(notify.info?.nickName),
      } satisfies PushFriendAddEvent;
    } catch {
      return system(raw);
    }
  }

  if (h.subType === SUBTYPE_POKE) {
    const poke = decodePoke(h.content, h.time);
    if (poke) return poke;
  }

  return system(raw);
}

function decodePoke(content: Uint8Array, time: number): PushPokeEvent | null {
  try {
    const tip = decode(GENERAL_GRAY_TIP, content) as {
      busiType?: bigint;
      msgTemplParam?: { name?: string; value?: string }[];
    };
    if ((tip.busiType ?? 0n) !== GRAY_TIP_POKE_BUSI_TYPE) return null;
    const templates = templateMap(tip.msgTemplParam);
    const fromUid = templates.get('uin_str1') ?? '';
    const toUid = templates.get('uin_str2') ?? '';
    if (!fromUid || !toUid) return null;
    return {
      kind: 'poke',
      time,
      fromUid,
      toUid,
      ...(templates.has('action_str') ? { action: templates.get('action_str') } : {}),
      ...(templates.has('suffix_str') ? { suffix: templates.get('suffix_str') } : {}),
    };
  } catch {
    return null;
  }
}

function templateMap(params: { name?: string; value?: string }[] | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const param of params ?? []) {
    if (param.name) out.set(param.name, param.value ?? '');
  }
  return out;
}

// ─────────────────────────── 0x2dc ───────────────────────────

function decode0x2DC(raw: RawMessageBody): PushEvent | null {
  const h = head(raw);
  switch (h.subType) {
    case SUBTYPE_GROUP_RECALL:
      return decodeGroupRecall(raw);
    case SUBTYPE_GROUP_MUTE:
      return decodeGroupMute(raw);
    case SUBTYPE_GROUP_REACTION:
      return decodeGroupReaction(raw);
    case SUBTYPE_GROUP_GRAY_TIP:
      return decodeGroupGrayTip(raw);
    case SUBTYPE_GROUP_ESSENCE:
      return decodeGroupEssence(raw);
    default:
      return system(raw);
  }
}

function decodeGroupRecall(raw: RawMessageBody): PushEvent | null {
  const h = head(raw);
  const payload = unwrapGroupNotify(h.content);
  if (!payload) return system(raw);
  try {
    const notify = decode(GROUP_NOTIFY_BODY, payload) as {
      groupUin?: number;
      operatorUid?: string;
      recall?: {
        operatorUid?: string;
        recallMessages?: { sequence?: number; time?: number; authorUid?: string }[];
      };
    };
    const recalled = notify.recall?.recallMessages?.[0];
    if (!recalled) return system(raw);
    return {
      kind: 'group-recall',
      time: recalled.time ?? h.time,
      groupUin: notify.groupUin ?? h.groupUin,
      operatorUid: notify.recall?.operatorUid || notify.operatorUid || '',
      authorUid: recalled.authorUid ?? '',
      sequence: recalled.sequence ?? 0,
    } satisfies PushGroupRecallEvent;
  } catch {
    return system(raw);
  }
}

function decodeGroupMute(raw: RawMessageBody): PushEvent | null {
  const h = head(raw);
  try {
    const mute = decode(GROUP_MUTE, h.content) as {
      groupUin?: number;
      operatorUid?: string;
      data?: { timestamp?: number; state?: { targetUid?: string; duration?: number } };
    };
    const state = mute.data?.state;
    if (!state) return system(raw);
    return {
      kind: 'group-mute',
      time: mute.data?.timestamp ?? h.time,
      groupUin: mute.groupUin ?? h.groupUin,
      targetUid: asUid(state.targetUid),
      operatorUid: asUid(mute.operatorUid),
      // QQ 用 0xffffffff 表示「一直禁言」。
      duration: state.duration === 0xffffffff ? 0x7fffffff : (state.duration ?? 0),
    } satisfies PushGroupMuteEvent;
  } catch {
    return system(raw);
  }
}

function decodeGroupReaction(raw: RawMessageBody): PushEvent | null {
  const h = head(raw);
  const payload = unwrapGroupNotify(h.content);
  if (!payload) return system(raw);
  try {
    const notify = decode(GROUP_REACT, payload) as {
      groupUin?: bigint;
      field13?: number;
      groupReactionData?: {
        data?: {
          data?: {
            groupReactionTarget?: { seq?: bigint };
            groupReactionDataContent?: {
              code?: string;
              count?: number;
              operatorUid?: string;
              type?: number;
            };
          };
        };
      };
    };
    if ((notify.field13 ?? 0) !== FIELD13_EMOJI_REACT) return system(raw);
    const content = notify.groupReactionData?.data?.data?.groupReactionDataContent;
    const target = notify.groupReactionData?.data?.data?.groupReactionTarget;
    if (!content) return system(raw);
    return {
      kind: 'group-reaction',
      time: h.time,
      groupUin: asNumber(notify.groupUin) || h.groupUin,
      sequence: asNumber(target?.seq),
      code: asUid(content.code),
      count: content.count ?? 1,
      operatorUid: asUid(content.operatorUid),
      added: (content.type ?? 1) === 1,
    } satisfies PushGroupReactionEvent;
  } catch {
    return system(raw);
  }
}

function decodeGroupGrayTip(raw: RawMessageBody): PushEvent | null {
  const h = head(raw);
  const payload = unwrapGroupNotify(h.content);
  if (!payload) return system(raw);
  try {
    const notify = decode(GROUP_NOTIFY_BODY, payload) as {
      groupUin?: number;
      generalGrayTip?: {
        busiType?: bigint;
        msgTemplParam?: { name?: string; value?: string }[];
      };
    };
    const tip = notify.generalGrayTip;
    if (!tip || (tip.busiType ?? 0n) !== GRAY_TIP_POKE_BUSI_TYPE) return system(raw);
    const templates = templateMap(tip.msgTemplParam);
    const fromUid = templates.get('uin_str1') ?? '';
    const toUid = templates.get('uin_str2') ?? '';
    if (!fromUid || !toUid) return system(raw);
    return {
      kind: 'poke',
      time: h.time,
      fromUid,
      toUid,
      groupUin: notify.groupUin ?? h.groupUin,
      ...(templates.has('action_str') ? { action: templates.get('action_str') } : {}),
      ...(templates.has('suffix_str') ? { suffix: templates.get('suffix_str') } : {}),
    } satisfies PushPokeEvent;
  } catch {
    return system(raw);
  }
}

function decodeGroupEssence(raw: RawMessageBody): PushEvent | null {
  const h = head(raw);
  const payload = unwrapGroupNotify(h.content);
  if (!payload) return system(raw);
  try {
    const notify = decode(GROUP_NOTIFY_BODY, payload) as {
      groupUin?: number;
      msgSequence?: number;
      essenceMessage?: {
        groupUin?: number;
        msgSequence?: number;
        msgSequence2?: number;
        setFlag?: number;
        setFlag2?: number;
        memberUin?: number;
        operatorUin?: number;
        timestamp?: number;
      };
    };
    const essence = notify.essenceMessage;
    if (!essence) return system(raw);
    return {
      kind: 'group-essence',
      time: essence.timestamp ?? h.time,
      groupUin: essence.groupUin ?? notify.groupUin ?? h.groupUin,
      sequence: essence.msgSequence ?? essence.msgSequence2 ?? notify.msgSequence ?? 0,
      operatorUid: '',
      memberUin: essence.memberUin ?? 0,
      set: (essence.setFlag ?? essence.setFlag2 ?? 0) === 1,
    } satisfies PushGroupEssenceEvent;
  } catch {
    return system(raw);
  }
}

// ─────────────────────────── 33 / 34 / 44 / 85 ───────────────────────────

function decodeGroupMember(raw: RawMessageBody): PushEvent | null {
  const h = head(raw);
  if (h.msgType === 85) {
    try {
      const joined = decode(SELF_JOIN_GROUP, h.content) as {
        groupUin?: bigint;
        operatorUid?: string;
      };
      const groupUin = asNumber(joined.groupUin);
      if (!groupUin) return system(raw);
      return {
        kind: 'group-member',
        time: h.time,
        groupUin,
        memberUid: '',
        operatorUid: asUid(joined.operatorUid),
        action: 'self-join',
      } satisfies PushGroupMemberEvent;
    } catch {
      return system(raw);
    }
  }

  try {
    const change = decode(GROUP_CHANGE, h.content) as {
      groupUin?: number;
      memberUid?: string;
      decreaseType?: number;
      operatorBytes?: Uint8Array;
    };
    const groupUin = change.groupUin ?? h.groupUin;
    const memberUid = asUid(change.memberUid);
    if (!groupUin || !memberUid) return system(raw);
    const dt = change.decreaseType ?? 0;

    if (h.msgType === 33) {
      const operation = dt - (dt & 0x80);
      return {
        kind: 'group-member',
        time: h.time,
        groupUin,
        memberUid,
        action: 'join',
        // 入群的 operatorBytes 两种形态都见过（裸 uid / OperatorInfo）。
        operatorUid: decodeOperator(change.operatorBytes, true),
        joinType: operation === 3 ? 'invite' : 'approve',
      } satisfies PushGroupMemberEvent;
    }

    const leaveType = dt === 129 ? 'disband' : dt === 0 || dt === 130 ? 'leave' : 'kick';
    return {
      kind: 'group-member',
      time: h.time,
      groupUin,
      memberUid,
      // 主动退群没有独立操作者，OneBot 语义里就是本人。
      operatorUid: dt === 130 ? memberUid : decodeOperator(change.operatorBytes, dt !== 3),
      action: leaveType === 'disband' ? 'disband' : 'leave',
      leaveType,
    } satisfies PushGroupMemberEvent;
  } catch {
    return system(raw);
  }
}

function decodeGroupAdmin(raw: RawMessageBody): PushEvent | null {
  const h = head(raw);
  try {
    const admin = decode(GROUP_ADMIN, h.content) as {
      groupUin?: number;
      body?: {
        extraEnable?: { adminUid?: string };
        extraDisable?: { adminUid?: string };
      };
    };
    const enableUid = asUid(admin.body?.extraEnable?.adminUid);
    const disableUid = asUid(admin.body?.extraDisable?.adminUid);
    const memberUid = enableUid || disableUid;
    if (!memberUid) return system(raw);
    return {
      kind: 'group-admin',
      time: h.time,
      groupUin: admin.groupUin ?? h.groupUin,
      memberUid,
      set: Boolean(enableUid),
    } satisfies PushGroupAdminEvent;
  } catch {
    return system(raw);
  }
}

// ─────────────────────────── 84 / 525 / 87 ───────────────────────────

function decodeGroupRequest(raw: RawMessageBody): PushEvent | null {
  const h = head(raw);

  if (h.msgType === 84) {
    try {
      const join = decode(GROUP_JOIN, h.content) as { groupUin?: number; targetUid?: string };
      const fromUid = asUid(join.targetUid);
      if (!join.groupUin || !fromUid) return system(raw);
      return {
        kind: 'group-request',
        time: h.time,
        groupUin: join.groupUin,
        fromUid,
        subType: 'add',
        message: '',
        flag: `add:${join.groupUin}:${fromUid}`,
      } satisfies PushGroupRequestEvent;
    } catch {
      return system(raw);
    }
  }

  if (h.msgType === 525) {
    try {
      const invitation = decode(GROUP_INVITATION, h.content) as {
        cmd?: number;
        info?: {
          inner?: { groupUin?: number; targetUid?: string; invitorUid?: string };
        };
      };
      const inner = invitation.info?.inner;
      if (invitation.cmd !== 87 || !inner?.groupUin) return system(raw);
      const fromUid = asUid(inner.invitorUid);
      return {
        kind: 'group-request',
        time: h.time,
        groupUin: inner.groupUin,
        fromUid,
        ...(inner.targetUid ? { invitedUid: inner.targetUid } : {}),
        subType: 'invite',
        message: '',
        flag: `invite:${inner.groupUin}:${fromUid}`,
      } satisfies PushGroupRequestEvent;
    } catch {
      return system(raw);
    }
  }

  try {
    const invite = decode(GROUP_INVITE, h.content) as { groupUin?: number; invitorUid?: string };
    if (!invite.groupUin) return system(raw);
    const fromUid = asUid(invite.invitorUid);
    return {
      kind: 'group-request',
      time: h.time,
      groupUin: invite.groupUin,
      fromUid,
      subType: 'invite',
      message: '',
      flag: `invite:${invite.groupUin}:${fromUid}`,
    } satisfies PushGroupRequestEvent;
  } catch {
    return system(raw);
  }
}

// ─────────────────────────── 默认注册表 ───────────────────────────

/** 生产用的分派表：`msgType → decoder`。 */
export function createMsgPushRegistry(): MsgPushRegistry {
  return new MsgPushRegistry()
    .register([33, 34, 85], decodeGroupMember)
    .register(44, decodeGroupAdmin)
    .register([84, 525, 87], decodeGroupRequest)
    .register(528, decode0x210)
    .register(732, decode0x2DC);
}
