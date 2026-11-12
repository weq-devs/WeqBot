export {
  inspectNative,
  type CapabilityReport,
  type NativeCapability,
} from './capabilities';
export { adaptNativeBinding, type RawNativeBinding } from './adapt';
// 签名表与发包包装**不在这里** —— 它们是协议知识，住在 `@weqbot/protocol`。
// wire 只保留「怎么发字节」的契约（`NativePort`）与会话身份（`SessionId`）。
export type {
  DeviceProfile,
  NativeBuildInfo,
  NativePort,
  OpenSessionOptions,
  OpenedSession,
  PushFrame,
  PushSink,
  PushSinkError,
  QuickLoginOptions,
  QuickLoginResult,
  ResolvedSign,
  SessionId,
  SessionInfo,
  SessionMode,
  SessionStatusEvent,
  SignMode,
  SignerPaths,
  SsoSessionConfig,
} from './types';
