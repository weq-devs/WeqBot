/**
 * 推送侧用到的 protobuf schema。
 *
 * `PUSH_MSG`（`msg/schemas.ts`）把 tag 1 声明成**单条** message；线上同一帧
 * 出现多条时后者会覆盖前者。推送通道不能丢消息，所以这里单独声明一份
 * repeated 的包壳，逐条交给 `decodeMessageBody`。
 */

import { message, type ProtoMessage } from '../protobuf';
import { PUSH_MSG_BODY } from '../msg/schemas';

/** `trpc.msg.olpush.OlPushService.MsgPush` 的包壳。 */
export const MSG_PUSH_ENVELOPE: ProtoMessage = message([
  { name: 'messages', tag: 1, type: PUSH_MSG_BODY, repeated: true },
  { name: 'status', tag: 3, type: 'int32' },
]);

// ---------- 0x210 子类型载荷 ----------

/** 0x210/277 `aio_input_state_worker.cc::InputStatusNotify`。 */
export const INPUT_STATUS_NOTIFY: ProtoMessage = message([
  { name: 'fromUid', tag: 1, type: 'string' },
  { name: 'toUid', tag: 2, type: 'string' },
  {
    name: 'notifyItem',
    tag: 3,
    type: message([
      { name: 'field2', tag: 2, type: 'uint32' },
      { name: 'field3', tag: 3, type: 'uint64' },
      { name: 'eventType', tag: 4, type: 'uint32' },
      { name: 'field5', tag: 5, type: 'uint32' },
      { name: 'statusText', tag: 6, type: 'string' },
    ]),
  },
]);

/** 0x210/138、139 `FriendRecall`。 */
export const FRIEND_RECALL: ProtoMessage = message([
  {
    name: 'info',
    tag: 1,
    type: message([
      { name: 'fromUid', tag: 1, type: 'string' },
      { name: 'toUid', tag: 2, type: 'string' },
      { name: 'clientSequence', tag: 3, type: 'uint32' },
      { name: 'newId', tag: 4, type: 'uint64' },
      { name: 'time', tag: 5, type: 'uint32' },
    ]),
  },
]);

// ---------- 0x2dc 子类型载荷 ----------

/** 0x2dc 的 content 外面套了一层 7 字节壳（见 `unwrapGroupNotify`）。 */
export const GROUP_NOTIFY_BODY: ProtoMessage = message([
  { name: 'type', tag: 1, type: 'uint32' },
  { name: 'groupUin', tag: 4, type: 'uint32' },
  { name: 'eventParam', tag: 5, type: 'bytes' },
  {
    name: 'recall',
    tag: 11,
    type: message([
      { name: 'operatorUid', tag: 1, type: 'string' },
      {
        name: 'recallMessages',
        tag: 3,
        type: message([
          { name: 'sequence', tag: 1, type: 'uint32' },
          { name: 'time', tag: 2, type: 'uint32' },
          { name: 'authorUid', tag: 6, type: 'string' },
        ]),
        repeated: true,
      },
    ]),
  },
  { name: 'field13', tag: 13, type: 'uint32' },
  { name: 'operatorUid', tag: 21, type: 'string' },
  {
    name: 'generalGrayTip',
    tag: 26,
    type: message([
      { name: 'busiType', tag: 1, type: 'uint64' },
      { name: 'busiId', tag: 2, type: 'uint64' },
      { name: 'ctrlFlag', tag: 3, type: 'uint32' },
      { name: 'c2cType', tag: 4, type: 'uint32' },
      { name: 'serviceType', tag: 5, type: 'uint32' },
      { name: 'templId', tag: 6, type: 'uint64' },
      {
        name: 'msgTemplParam',
        tag: 7,
        type: message([
          { name: 'name', tag: 1, type: 'string' },
          { name: 'value', tag: 2, type: 'string' },
        ]),
        repeated: true,
      },
      { name: 'content', tag: 8, type: 'string' },
    ]),
  },
  {
    name: 'essenceMessage',
    tag: 33,
    type: message([
      { name: 'groupUin', tag: 1, type: 'uint32' },
      { name: 'msgSequence', tag: 2, type: 'uint32' },
      { name: 'random', tag: 3, type: 'uint32' },
      { name: 'setFlag', tag: 4, type: 'uint32' },
      { name: 'memberUin', tag: 5, type: 'uint32' },
      { name: 'operatorUin', tag: 6, type: 'uint32' },
      { name: 'timestamp', tag: 7, type: 'uint32' },
      { name: 'msgSequence2', tag: 8, type: 'uint32' },
      { name: 'setFlag2', tag: 11, type: 'uint32' },
    ]),
  },
  { name: 'msgSequence', tag: 37, type: 'uint32' },
]);

// ---------- 33 / 34 / 85 群成员变动 ----------

/** 33（入群）/ 34（退群）：`GroupChange`。 */
export const GROUP_CHANGE: ProtoMessage = message([
  { name: 'groupUin', tag: 1, type: 'uint32' },
  { name: 'flag', tag: 2, type: 'uint32' },
  { name: 'memberUid', tag: 3, type: 'string' },
  { name: 'decreaseType', tag: 4, type: 'uint32' },
  { name: 'operatorBytes', tag: 5, type: 'bytes' },
  { name: 'increaseType', tag: 6, type: 'uint32' },
]);

/** 85（自己入群）：`SelfJoinInGroup`；groupUin 在 wire 上是 uint64。 */
export const SELF_JOIN_GROUP: ProtoMessage = message([
  { name: 'groupUin', tag: 1, type: 'uint64' },
  { name: 'field2', tag: 2, type: 'uint32' },
  { name: 'operatorUid', tag: 3, type: 'string' },
]);

/** `GroupChange.operatorBytes` 里可能是裸 uid，也可能是 `OperatorInfo`。 */
export const GROUP_CHANGE_OPERATOR: ProtoMessage = message([
  {
    name: 'operatorField',
    tag: 1,
    type: message([{ name: 'uid', tag: 1, type: 'string' }]),
  },
]);

// ---------- 44 群管理员变更 ----------

export const GROUP_ADMIN: ProtoMessage = message([
  { name: 'groupUin', tag: 1, type: 'uint32' },
  { name: 'flag', tag: 2, type: 'uint32' },
  { name: 'isPromote', tag: 3, type: 'bool' },
  {
    name: 'body',
    tag: 4,
    type: message([
      {
        name: 'extraDisable',
        tag: 1,
        type: message([
          { name: 'adminUid', tag: 1, type: 'string' },
          { name: 'isPromote', tag: 2, type: 'bool' },
        ]),
      },
      {
        name: 'extraEnable',
        tag: 2,
        type: message([
          { name: 'adminUid', tag: 1, type: 'string' },
          { name: 'isPromote', tag: 2, type: 'bool' },
        ]),
      },
    ]),
  },
]);

// ---------- 84 / 525 / 87 群申请 / 邀请 ----------

export const GROUP_JOIN: ProtoMessage = message([
  { name: 'groupUin', tag: 1, type: 'uint32' },
  { name: 'field2', tag: 2, type: 'uint32' },
  { name: 'targetUid', tag: 3, type: 'string' },
  { name: 'field4', tag: 4, type: 'uint32' },
  { name: 'field6', tag: 6, type: 'uint32' },
  { name: 'field7', tag: 7, type: 'string' },
]);

export const GROUP_INVITATION: ProtoMessage = message([
  { name: 'cmd', tag: 1, type: 'int32' },
  {
    name: 'info',
    tag: 2,
    type: message([
      {
        name: 'inner',
        tag: 1,
        type: message([
          { name: 'groupUin', tag: 1, type: 'uint32' },
          { name: 'targetUid', tag: 5, type: 'string' },
          { name: 'invitorUid', tag: 6, type: 'string' },
          { name: 'field12', tag: 12, type: 'string' },
        ]),
      },
    ]),
  },
]);

export const GROUP_INVITE: ProtoMessage = message([
  { name: 'groupUin', tag: 1, type: 'uint32' },
  { name: 'field2', tag: 2, type: 'uint32' },
  { name: 'field3', tag: 3, type: 'uint32' },
  { name: 'field4', tag: 4, type: 'uint32' },
  { name: 'invitorUid', tag: 5, type: 'string' },
]);

// ---------- 0x210 好友申请 / 新好友 / 戳一戳 ----------

export const FRIEND_REQUEST: ProtoMessage = message([
  {
    name: 'info',
    tag: 1,
    type: message([
      { name: 'targetUid', tag: 1, type: 'string' },
      { name: 'sourceUid', tag: 2, type: 'string' },
      { name: 'newSource', tag: 5, type: 'string' },
      { name: 'message', tag: 10, type: 'string' },
      { name: 'source', tag: 11, type: 'string' },
    ]),
  },
]);

export const NEW_FRIEND: ProtoMessage = message([
  { name: 'field1', tag: 1, type: 'uint32' },
  {
    name: 'info',
    tag: 2,
    type: message([
      { name: 'uid', tag: 1, type: 'string' },
      { name: 'field2', tag: 2, type: 'uint32' },
      { name: 'time', tag: 3, type: 'uint32' },
      { name: 'message', tag: 4, type: 'string' },
      { name: 'nickName', tag: 5, type: 'string' },
      { name: 'toUid', tag: 9, type: 'string' },
    ]),
  },
]);

/** 戳一戳：`GeneralGrayTip`，busiType=12，模板里 uin_str1/uin_str2。 */
export const GENERAL_GRAY_TIP: ProtoMessage = message([
  { name: 'busiType', tag: 1, type: 'uint64' },
  { name: 'busiId', tag: 2, type: 'uint64' },
  { name: 'ctrlFlag', tag: 3, type: 'uint32' },
  { name: 'c2cType', tag: 4, type: 'uint32' },
  { name: 'serviceType', tag: 5, type: 'uint32' },
  { name: 'templId', tag: 6, type: 'uint64' },
  {
    name: 'msgTemplParam',
    tag: 7,
    type: message([
      { name: 'name', tag: 1, type: 'string' },
      { name: 'value', tag: 2, type: 'string' },
    ]),
    repeated: true,
  },
  { name: 'content', tag: 8, type: 'string' },
]);

// ---------- 0x2dc 禁言 / 表情回应 ----------

export const GROUP_MUTE: ProtoMessage = message([
  { name: 'groupUin', tag: 1, type: 'uint32' },
  { name: 'subType', tag: 2, type: 'uint32' },
  { name: 'field3', tag: 3, type: 'uint32' },
  { name: 'operatorUid', tag: 4, type: 'string' },
  {
    name: 'data',
    tag: 5,
    type: message([
      { name: 'timestamp', tag: 1, type: 'uint32' },
      { name: 'type', tag: 2, type: 'uint32' },
      {
        name: 'state',
        tag: 3,
        type: message([
          { name: 'targetUid', tag: 1, type: 'string' },
          { name: 'duration', tag: 2, type: 'uint32' },
        ]),
      },
    ]),
  },
]);

/** `SendMessageResponse`：客户端回执尾部那段（取确认序号与时间）。 */
export const SEND_MESSAGE_RESPONSE: ProtoMessage = message([
  { name: 'result', tag: 1, type: 'int32' },
  { name: 'errMsg', tag: 2, type: 'string' },
  { name: 'timestamp1', tag: 3, type: 'uint32' },
  { name: 'reviewResult', tag: 6, type: 'int32' },
  {
    name: 'serverResult',
    tag: 7,
    type: message([
      { name: 'type', tag: 1, type: 'int32' },
      { name: 'code', tag: 2, type: 'int32' },
    ]),
  },
  { name: 'groupSequence', tag: 11, type: 'uint32' },
  { name: 'privateSequence', tag: 14, type: 'uint32' },
]);

export const GROUP_REACT: ProtoMessage = message([
  { name: 'groupUin', tag: 4, type: 'uint64' },
  { name: 'field13', tag: 13, type: 'uint32' },
  {
    name: 'groupReactionData',
    tag: 44,
    type: message([
      {
        name: 'data',
        tag: 1,
        type: message([
          {
            name: 'data',
            tag: 1,
            type: message([
              {
                name: 'groupReactionTarget',
                tag: 2,
                type: message([{ name: 'seq', tag: 1, type: 'uint64' }]),
              },
              {
                name: 'groupReactionDataContent',
                tag: 3,
                type: message([
                  { name: 'code', tag: 1, type: 'string' },
                  { name: 'count', tag: 3, type: 'uint32' },
                  { name: 'operatorUid', tag: 4, type: 'string' },
                  { name: 'type', tag: 5, type: 'uint32' },
                ]),
              },
            ]),
          },
        ]),
      },
    ]),
  },
]);
