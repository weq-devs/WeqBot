/**
 * `@weqbot/onebot` —— OneBot v11 适配层。
 *
 * 分层（由下到上）：
 *   types.ts           线上类型（响应信封 / 网络配置 / MessageMeta）
 *   cq.ts              CQ 码编解码
 *   message-parser.ts  `message` 参数 → 中间元素形状
 *   segments.ts        **一张双向表**：协议元素 ⇄ OneBot segment
 *   event-converter.ts `BotEvent` → OneBot post
 *   backend.ts         业务能力接口（由 `@weqbot/bot` 用协议实现）
 *   action-registry.ts 注册表 + 校验 + 错误码 + 敏感能力 deny-list
 *   actions/           各个 action 的实现
 *   network/           WS 正向 / 反向、HTTP（`ws` 纯 JS）
 *   adapter.ts         `createOneBotAdapter`：把上面组装起来
 *
 * 不负责：协议细节（`@weqbot/protocol`）、登录上线（`@weqbot/session`）。
 *
 * 敏感能力（红包 / 转账 / 支付）**永不进 action 表**，见 `DENIED_ACTIONS`。
 */

export {
  ActionRegistry,
  DENIED_ACTIONS,
  describeAction,
  isDeniedAction,
  ParamError,
  optionalBool,
  optionalPositiveInt,
  optionalString,
  requiredInt,
  requiredPositiveInt,
  requiredString,
  type ActionContext,
  type ActionDefinition,
  type ActionDoc,
  type ActionListEntry,
  type ParamParser,
} from './action-registry';
export {
  ACTION_METADATA,
  actionMetadata,
  type ActionMetadata,
  type JsonSchema,
} from './action-metadata';
export {
  createOneBotAdapter,
  type ActionDispatchOptions,
  type ActionDispatcher,
  type CreateOneBotAdapterOptions,
  type OneBotAdapter,
} from './adapter';
export {
  ALL_ACTIONS,
  describeActions,
  registerActions,
  type ActionEntry,
} from './actions';
export {
  NotImplementedError,
  describeBackend,
  type FlashFileItem,
  type FlashTransferBackend,
  type ForwardMessageNode,
  type ForwardNode,
  type AiVoiceBackend,
  type AiVoiceCategory,
  type AiVoiceCharacter,
  type ContactsExtraBackend,
  type ForwardPreview,
  type FriendInfo,
  type FriendProfile,
  type GroupAdminExtraBackend,
  type GroupAdminPermissions,
  type GroupAdminSettings,
  type GroupInfo,
  type GroupMemberInvitePolicy,
  type GroupInfoEx,
  type GroupMemberInfo,
  type HistoryMessage,
  type LoginInfo,
  type MiscBackend,
  type OneBotBackend,
  type ProfileBackend,
  type ProfileLikeInfo,
  type ProfileLikeUserInfo,
  type ReadReportBackend,
  type Segment as BackendSegment,
  type RecallTarget,
  type SendResult,
  type StrangerInfo,
  type GroupSystemMessage,
} from './backend';
export { cqEscape, cqUnescape, parseCQString, segmentToCQ, segmentsToRawMessage } from './cq';
export {
  convertEvent,
  convertMessage,
  convertNotice,
  convertRequest,
  heartbeatMetaEvent,
  lifecycleMetaEvent,
  type ConverterContext,
} from './event-converter';
export { MessageIdMap, type MessageIdEntry, type MessageIdMapOptions } from './message-id';
export { parseMessageSegments } from './message-parser';
export { MessageStore, type StoredMessage } from './message-store';
export {
  ELEMENT_CODECS,
  decodeInlineMedia,
  elementToSegment,
  elementsToSegments,
  getElementCodec,
  getSegmentCodec,
  intOr,
  isInlineMediaSource,
  pickMediaSource,
  segmentsToElements,
  type ElementCodec,
  type FromSegmentContext,
  type InboundElement,
  type OutboundElement,
  type Segment,
  type ToSegmentContext,
} from './segments';
export {
  RETCODE,
  failedResponse,
  hasAuthoritativeSequence,
  okResponse,
  type ApiResponse,
  type HttpClientNetwork,
  type HttpServerNetwork,
  type JsonArray,
  type JsonObject,
  type JsonPrimitive,
  type JsonValue,
  type MessageFormat,
  type MessageMeta,
  type NetworkBase,
  type OneBotConfig,
  type OneBotIdentity,
  type OneBotNetworks,
  type OneBotRequest,
  type WsClientNetwork,
  type WsFrameLimitConfig,
  type WsRole,
  type WsServerNetwork,
} from './types';
