/**
 * `@weqbot/protocol/push` —— 服务端推送解码。
 *
 * 入口只有三个：
 *   - {@link decodePushFrame}：一帧 `PushFrame`（native 交出来的 command/body）；
 *   - {@link decodePushBody}：只有 `MsgPush` body；
 *   - {@link decodeMessageBodies}：历史 / 合并转发里的 `PUSH_MSG_BODY` 列表。
 */

export {
  CLIENT_MESSAGE_RECEIPT_CMD,
  decodeMessageBodies,
  decodePushBody,
  decodePushEnvelope,
  decodePushFrame,
  MSG_PUSH_CMD,
  type DecodedPushEnvelope,
  type DecodePushOptions,
} from './decode';
export {
  FRIEND_RECALL,
  GROUP_NOTIFY_BODY,
  INPUT_STATUS_NOTIFY,
  MSG_PUSH_ENVELOPE,
} from './schemas';
export type {
  PushEvent,
  PushFriendRecallEvent,
  PushGroupRecallEvent,
  PushInputStatusEvent,
  PushMessageEvent,
  PushOtherEvent,
  PushScene,
  PushSystemEvent,
} from './types';
