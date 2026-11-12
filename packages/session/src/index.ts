/**
 * `@weqbot/session` —— 登录与在线会话。
 *
 * 负责：a1 凭据的取用、`quickLogin` 换票、`openSession(mode 2)` 注册、掉线判定与重登编排、
 * 推送帧 → `BotEvent` 的翻译。
 *
 * 不负责：socket / 心跳计时（native 的）、OneBot 词汇（`@weqbot/onebot` 的）、
 * 消息元素编解码（`@weqbot/protocol` 的）。
 *
 * TODO(P3)：`BotSession` 本体（`start` / `stop` / `call`）—— 依赖 P2 的 native
 * `openSession` 落地，接口见 `TODO.md`「session 契约」。
 */

export type {
  BotEvent,
  BotEventMap,
  InboundMessage,
  MessageScene,
  NoticeEvent,
  OfflineReason,
  PeerRef,
  RequestEvent,
  SessionEvent,
} from './events';
export {
  canTransition,
  IllegalTransitionError,
  SessionStateMachine,
  type SessionState,
  type StateChange,
} from './state';
export type {
  AccountSummary,
  CredentialEnvelope,
  CredentialVault,
  StoredAccount,
} from './credentials';
