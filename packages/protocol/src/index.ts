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
export * from './oidb';
export * from './msg';
export * from './push';
export { decode, encode, message, ProtoNotPortedError } from './protobuf';
export type { ProtoField, ProtoMessage, ScalarType } from './protobuf';
