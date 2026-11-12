/**
 * `@weqbot/protocol` —— QQ 协议层：从 wire 字节到业务对象。
 *
 * 分层纪律：
 *   - 不碰会话生命周期（登录 / 上线 / 重连都在 `@weqbot/session`）；
 *   - 不碰 OneBot 词汇；
 *   - 不知道自己跑在独立进程还是 WeQ 里；
 *   - native 只通过 `@weqbot/wire` 的端口访问。
 */

export { createProtocolClient, type ProtocolClient, type ProtocolClientOptions } from './client';
export * from './highway';
export * from './msg';
export * from './oidb';
export * from './push';
export * from './transport';
export {
  RED_BAG_SIGN_SALT1,
  RED_BAG_SIGN_SALT2,
  signRedBagRequest as signRedBagRequestPure,
} from './redbag/sign';
export { decode, encode, message } from './protobuf';
export type { ProtoField, ProtoMessage, ScalarType } from './protobuf';
export {
  oidbCommand,
  resolveSign,
  SIGN_RULES,
  UNCONFIRMED_SIGN_COMMANDS,
  type PerPlatform,
  type ResolvedSign,
  type SignedCommand,
  type SignMode,
  type SignRule,
  type SignRuleSwitch,
} from './sign-policy';
