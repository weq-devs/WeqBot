export {
  inspectNative,
  type CapabilityReport,
  type NativeCapability,
} from './capabilities';
export { adaptNativeBinding, type RawNativeBinding } from './adapt';
// 签名表与发包包装**不在这里** —— 它们是协议知识，住在 `@weqbot/protocol`。
// wire 只保留「怎么发字节」的契约（`NativePort`）与目标区间判断。
export {
  ONLINE_TARGET_BASE,
  isOnlineTarget,
  onlineHandle,
  type DeviceProfile,
  type NativeBuildInfo,
  type NativePort,
  type OnlineOpenOptions,
  type OnlineSession,
  type OnlineStatusEvent,
  type OnlineStatusEvent as OnlineStatus,
  type PushFrame,
  type PushSink,
  type QuickLoginOptions,
  type QuickLoginResult,
  type ResolvedSign,
  type SecureMaterial,
  type SignMode,
  type SignerPaths,
  type SsoSessionConfig,
  type SsoTarget,
} from './types';
