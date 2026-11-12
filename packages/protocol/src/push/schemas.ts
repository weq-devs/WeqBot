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
  { name: 'operatorUid', tag: 21, type: 'string' },
]);
