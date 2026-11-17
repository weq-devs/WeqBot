/**
 * 统一错误码。
 *
 * 这些码会出现在 IPC / WS 响应里，也是 WeQ 侧「要不要提示用户修 native」的判据，
 * 所以**只增不改**：新增场景加新码，不复用旧码表达新语义。
 */
export type WeqBotErrorCode =
  /** 组装调用缺少 native 端口（纯 TS 环境没注入）。 */
  | 'NATIVE_NOT_INJECTED'
  /** native 产物存在，但没有 weqbot 需要的能力（旧版本 / 阉割过度）。 */
  | 'NATIVE_MISSING_CAPABILITY'
  /** 登录失败：网络、风控、协议拒绝。 */
  | 'LOGIN_FAILED'
  /**
   * a1 已失效（服务端 `quickLogin` 返回 `140022015`）。
   *
   * 与 {@link LOGIN_FAILED} 的其它成因（网络 / 风控 / 协议拒绝）处理方式完全不同：
   * 这一种**必须停止重试** —— 反复拿失效 a1 换票只会引发风控。宿主收到它应当
   * 丢掉该账号的凭据并要求用户重新登录。也**不是** {@link ACCESS_DENIED}
   * （那是项目策略拒绝，与凭据无关）。
   */
  | 'A1_EXPIRED'
  /**
   * 项目策略拒绝登录 —— **与凭据无关**。
   *
   * 远端模式（native 在换票后、注册前拉取）返回 `exit` 时抛出。它不代表
   * a1 失效、风控或协议错误，所以不能归到 {@link LOGIN_FAILED}：那样会让用户
   * 被引导去「重新登录 / 重新扫码」，而实际操作是没用的。UI 应明确提示是
   * 当前构建的策略限制。
   */
  | 'ACCESS_DENIED'
  /** 该账号已有一条凭据路径在跑（mode1 与 mode2 互斥）。 */
  | 'ALREADY_ONLINE'
  /** 上线注册失败（SsoInfoSync 拒绝 / 超时）。 */
  | 'REGISTER_FAILED'
  /** 找不到可用的 `wrapper.node`，无法签名。 */
  | 'SIGNER_REQUIRED'
  /** 长连接掉了且不再重试。 */
  | 'CONNECTION_LOST'
  /** 凭据文件损坏 / 版本不认识。 */
  | 'CREDENTIAL_CORRUPT'
  /** 请求超时。 */
  | 'TIMEOUT'
  /** 会话已关闭，拒绝新的调用。 */
  | 'SESSION_CLOSED'
  /** desktop ↔ sidecar 控制通道：版本不符 / 非 JSON / 信封结构不合法。 */
  | 'CONTROL_PROTOCOL_ERROR'
  /** 明确的 NotImplemented：骨架期用，落地后必须清零。 */
  | 'NOT_IMPLEMENTED'
  /** 其它未归类。 */
  | 'UNKNOWN';

export interface WeqBotErrorDetail {
  /** 原始错误，日志里保留堆栈。 */
  cause?: unknown;
  /** 便于诊断的附加字段（不含凭据明文）。 */
  fields?: Record<string, unknown>;
}

export class WeqBotError extends Error {
  readonly code: WeqBotErrorCode;
  readonly detail: WeqBotErrorDetail;

  constructor(code: WeqBotErrorCode, message: string, detail: WeqBotErrorDetail = {}) {
    super(message, detail.cause === undefined ? undefined : { cause: detail.cause });
    this.name = 'WeqBotError';
    this.code = code;
    this.detail = detail;
  }
}

export function isWeqBotError(value: unknown): value is WeqBotError {
  return value instanceof WeqBotError;
}

/** 骨架期占位：实现落地时调用点会消失。 */
export function notImplemented(what: string): WeqBotError {
  return new WeqBotError('NOT_IMPLEMENTED', `${what} 尚未实现`);
}
