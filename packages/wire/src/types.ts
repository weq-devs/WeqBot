/**
 * 原生端口契约（`NativePort`）—— weqbot 与 nt_helper 之间的**唯一**接缝。
 *
 * ## 为什么是一份结构类型，而不是 `import type { NtHelperBinding } from '@weq/native'`
 *
 * bot 要同时活在三处：
 *
 *   1. 独立进程（`@weqbot/node`）拿 **slim native**；
 *   2. 嵌进 WeQ desktop，由 WeQ 注入**自己那份 full native**（纯 TS 打包，不带第二份 .node）；
 *   3. 测试里拿桩实现。
 *
 * 只要 weqbot 不 import `@weq/native`，第 2 种就不会把 WeQ 的私有包拖进依赖图，
 * 也不会让「两份 native」有存在的理由。宿主传进来的对象只要**结构上**满足
 * `NativePort` 即可（WeQ 的 `platform.native` 天然满足，见 `adaptNativeBinding`）。
 *
 * ## 必选 vs 可选
 *
 * 必选的只有两个发包出口（mode1 的 pid 路径和 mode2 的 handle 路径共用它们）。
 * 其余全部可选 —— 旧产物 / 阉割产物缺能力时由 `capabilities.ts` 探测并给出
 * 明确的 `NATIVE_MISSING_CAPABILITY`，而不是让类型在编译期把宿主卡死。
 */

/**
 * SSO 发包目标。
 *
 * **同一个 number 命名空间，两个来源**：
 *   - `[1, ONLINE_TARGET_BASE)` —— QQ 进程 pid（mode1：借 QQ 的会话物料）；
 *   - `[ONLINE_TARGET_BASE, …)` —— `openOnline()` 分配的在线会话句柄（mode2）。
 *
 * 这样 `sendPacket` / `sendOidbPacket` 只需要一个出口，`@weq/protocol` 那 161 个
 * spec 文件可以逐字搬运（它们传的就是 `pid: number`），不需要为 mode2 复制一套。
 *
 * 句柄区间取 1<<24 是因为 pid 的实际上限远小于它（Linux `pid_max` 默认 4194304，
 * 但 native 侧会在分配时校验冲突，不会真的撞上）。
 */
export type SsoTarget = number;

/** mode2 在线会话句柄的起点。 */
export const ONLINE_TARGET_BASE = 1 << 24;

/** 把从 0 开始的序号包成在线句柄。 */
export function onlineHandle(index: number): SsoTarget {
  return ONLINE_TARGET_BASE + index;
}

export function isOnlineTarget(target: SsoTarget): boolean {
  return target >= ONLINE_TARGET_BASE;
}

/** 签名器 VM mode。Linux 的 VM ABI 没有这个参数，固定 3。 */
export type SignMode = 2 | 3;

export interface ResolvedSign {
  /** 是否带 `SecInfo`（SSO reserved tag 24）。 */
  needSign: boolean;
  mode: SignMode;
}

/**
 * native 产物自报的构建信息（对应 nt_helper 的 `BuildInfo`）。
 *
 * `profile` 是 weqbot 引入的扩展：`'full'` = WeQ 桌面那份，`'bot'` = 独立分发的
 * 裁剪版。老产物没有这个字段，按 `'full'` 处理。
 */
export interface NativeBuildInfo {
  buildTime?: number;
  expireTime?: number;
  validitySecs: number;
  isDev: boolean;
  profile?: 'full' | 'bot';
  /** 权限助手接口版本；bot 不关心，留着便于诊断。 */
  authorizationInterface?: number;
}

/**
 * 签名器位置信息：QQ 的 `wrapper.node` 与静态扫描出的 RVA。
 *
 * mode2 没有 QQ 登录会话，`sec_sign` 只能靠 wrapper 算；`sec_extra` / `sec_token`
 * 的输入必须由 TS 侧给（见 {@link OnlineOpenOptions.secure}）。
 */
export interface SignerPaths {
  /** QQ 的 `wrapper.node` 绝对路径；null = 只能发不需要签名的命令。 */
  wrapperPath: string | null;
  signCoreRva?: number | null;
  vmRva?: number | null;
}

/**
 * mode2 需要 TS 侧提供的 `SsoSecureInfo` 原始素材。
 *
 * 这三者是一组（用户口径里的「extra」）：`sec_sign` 由 wrapper 算，`sec_extra` 是
 * `protobuf { 2: QUA }`，`sec_token` 在 mode1 来自 `scanSessionMaterial`、在 mode2
 * 没有来源，只能本地生成（生成规则见 TODO「待验证 / secToken」）。
 */
export interface SecureMaterial {
  /** 完整 QUA，如 `V1_LNX_NQ_3.2.34_53644_GW_B`（拼 `sec_extra` 用）。 */
  qua: string;
  /** `SecToken` 原文；mode2 由本地生成或从凭据库取。 */
  secToken: string;
  /** 覆盖 tag 15 `traceParent`（调试 / 离线比对用）。 */
  traceParent?: string | null;
}

/**
 * 一条 SSO 会话的物料（对应 nt_helper 的 `SsoSessionConfig`）。
 *
 * mode1：由 WeQ 从 QQ 进程内存扫出来，字节级原样下传。
 * mode2：由 `quickLogin(a1)` 的返回 + 设备档案拼出来，**只在内存里活**。
 */
export interface SsoSessionConfig {
  uin: string;
  /** a2（tgt）原文。 */
  a2: Uint8Array;
  /** d2 原文。 */
  d2: Uint8Array;
  /** d2key，16 字节。 */
  d2Key: Uint8Array;
  /** 设备 guid，32 位小写 hex。 */
  guid: string;
  /** 账号 uid（`u_...`）。 */
  uid: string;
  /** SSO subAppId，必须等于当前 QQ 构建的 appid。 */
  subAppId: number;
  clientVersion?: string;
  qua?: string | null;
  clientConnSeq?: string | null;
  traceParent?: string | null;
  secToken?: string | null;
}

/** 设备档案：跨重启必须稳定的非秘密字段。 */
export interface DeviceProfile {
  /** `linux` / `win32` / `darwin`，对应 nt_helper 的平台档案。 */
  os: 'linux' | 'win32' | 'darwin';
  /** EasyLogin `AppInfo.AppId`（不是 SSO subAppId）。 */
  appId: number;
  /** SSO subAppId（随 QQ 版本变）。 */
  subAppId: number;
  /** 完整 QUA。 */
  qua: string;
  /** QQ 客户端版本，如 `7.0.1-52892`。 */
  clientVersion: string;
  /** 设备名 / 内核版本等，按平台填入 `SsoSessionConfig` 之外的字段。 */
  deviceName?: string;
  kernelVersion?: string;
}

/**
 * mode1 的快速登录入参（对应 nt_helper 的 `QuickLoginOptions`）。
 *
 * `a1` 是**唯一需要长期持久化的凭据**；a2/d2/d2Key 是它的派生物，运行期易失。
 */
export interface QuickLoginOptions {
  uin: string;
  a1: Uint8Array;
  guid: string;
  appId?: number;
  subAppId?: number;
  qua?: string | null;
  clientVersion?: string | null;
  deviceName?: string | null;
  kernelVersion?: string | null;
  /** 传了就同连接发 `0xcde_2` 取数据库密钥；bot 不读 QQ 库，**永不传**。 */
  keyMeta?: unknown;
}

export interface QuickLoginResult {
  uin: string;
  uid: string;
  a2: Uint8Array;
  d2: Uint8Array;
  d2Key: Uint8Array;
  pskey?: string | null;
}

/** mode2 上线入参：只有 a1 派生物 + 设备档案 + 签名素材，**不接受扫描来的 a2/d2**。 */
export interface OnlineOpenOptions {
  uin: string;
  a1: Uint8Array;
  guid: string;
  device: DeviceProfile;
  secure: SecureMaterial;
  signer: SignerPaths;
  /**
   * wire 档位名（见 TODO「wire profile」）。native 侧按名字取常量组，
   * 换档不改 TS 代码。
   */
  wireProfile?: string;
}

export interface OnlineSession {
  /** 发给 `sendPacket` / `sendOidbPacket` 的句柄（≥ ONLINE_TARGET_BASE）。 */
  handle: SsoTarget;
  uin: string;
  /** native 侧是否已经完成注册（`SsoInfoSync` 已被服务端接受）。 */
  registered: boolean;
}

/**
 * 服务端推送的一帧。
 *
 * **native 不解 protobuf**：只剥 SSO 头、解密、把 `(command, body)` 原样交出来。
 * 解包在 `@weqbot/protocol/push`，这样新增推送类型不需要动 native。
 */
export interface PushFrame {
  handle: SsoTarget;
  /** SSO 命令名，如 `trpc.msg.olpush.OlPushService.MsgPush`。 */
  command: string;
  /** 解密后的原始 body 字节。 */
  body: Uint8Array;
  /** wire 上的 seq。 */
  seq: number;
  /** 收到时间（ms）。 */
  ts: number;
}

export type PushSink = (frame: PushFrame) => void;

/** 原生侧主动报告的会话状态变化。 */
export type OnlineStatusEvent =
  | { kind: 'registered'; handle: SsoTarget; ts: number }
  | { kind: 'heartbeat'; handle: SsoTarget; ts: number; rttMs?: number }
  | { kind: 'reconnecting'; handle: SsoTarget; attempt: number; ts: number }
  | { kind: 'reconnected'; handle: SsoTarget; ts: number }
  | { kind: 'kicked'; handle: SsoTarget; ts: number; reason?: string }
  | { kind: 'closed'; handle: SsoTarget; ts: number; reason?: string }
  /** TS 侧消费太慢，native 丢了帧（有界队列）。 */
  | { kind: 'sink_overflow'; handle: SsoTarget; ts: number; dropped: number };

/**
 * 原生端口。
 *
 * 所有方法都是 `Promise`（跨 napi 边界），所有字节参数都是 `Uint8Array`
 * （`adaptNativeBinding` 会转成 `Buffer` 交给真 native）。
 */
export interface NativePort {
  // ── 发包（mode1 / mode2 共用） ────────────────────────────────────────────
  sendPacket(
    target: SsoTarget,
    cmd: string,
    body: Uint8Array,
    needSign?: boolean | null,
    mode?: number | null,
  ): Promise<Uint8Array>;

  sendOidbPacket(
    target: SsoTarget,
    command: number,
    subCommand: number,
    body: Uint8Array,
    isUid: boolean,
    needSign: boolean,
    mode?: number | null,
  ): Promise<Uint8Array>;

  // ── mode1：借 QQ 会话物料 ─────────────────────────────────────────────────
  setSsoSession?(
    pid: number,
    session: SsoSessionConfig,
    wrapperPath?: string | null,
    signCoreRva?: number | null,
    vmRva?: number | null,
  ): Promise<void>;
  clearSsoSession?(pid: number): Promise<boolean>;
  hasSsoSession?(pid: number): Promise<boolean>;

  // ── mode2：自建上线 ──────────────────────────────────────────────────────
  quickLogin?(
    options: QuickLoginOptions,
    onEvent?: (error: Error | null, event: unknown) => unknown,
  ): Promise<QuickLoginResult>;
  /** 一键闭环：换票 → `SsoInfoSync` 注册 → 起心跳 → 开推送。 */
  openOnline?(options: OnlineOpenOptions): Promise<OnlineSession>;
  /** 主动下线：`UnRegister` + 关连接 + 释放句柄。 */
  closeOnline?(handle: SsoTarget, reason?: string): Promise<void>;
  /** 订阅推送；返回取消订阅函数。 */
  attachPushSink?(handle: SsoTarget, sink: PushSink): Promise<() => void>;
  /** 订阅状态变化；返回取消订阅函数。 */
  attachStatusSink?(
    handle: SsoTarget,
    sink: (event: OnlineStatusEvent) => void,
  ): Promise<() => void>;

  // ── 签名 / 诊断 ─────────────────────────────────────────────────────────
  warmupSigner?(wrapperPath: string): Promise<{ signCoreRva: number; vmRva: number }>;
  getBuildInfo?(): NativeBuildInfo;
}
