/**
 * 原生端口契约（`NativePort`）—— weqbot 与 nt_helper 之间的**唯一**接缝。
 *
 * ## 三层边界
 *
 * ```
 * 进程层   pid        hook / scanSessionMaterial / 数据库 / capture / runtime modules
 * 凭据层   a1         quickLogin / qrLogin → SsoSessionConfig
 * 会话层   sessionId  openSession / send* / closeSession / sinks
 * ```
 *
 * **pid 只属于进程层，绝不跨进会话层。** 会话的身份由 native 分配的
 * {@link SessionId} 持有，与「票据从哪来」无关：扫描得到的、`quickLogin`
 * 换来的、`qrLogin` 换来的，最终都是同一份 {@link SsoSessionConfig}，
 * 都走同一个 {@link NativePort.openSession}。
 *
 * ## 为什么 `openSession` 只有一个 mode 参数
 *
 * mode 1（借用）与 mode 2（自建）的差别只有两件事：
 *
 *   - 是否发 `SsoInfoSync` 注册；
 *   - 是否启动心跳。
 *
 * 连接、请求关联、签名、推送通道、关闭流程全部共用。`closeSession` 是否发
 * `UnRegister` 由会话自己的 `registered` 状态决定，不是第三个 mode 分支。
 *
 * ## 必选 vs 可选
 *
 * 必选的只有两个发包出口。其余全部可选 —— 旧产物 / 阉割产物缺能力时由
 * `capabilities.ts` 探测并给出明确的 `NATIVE_MISSING_CAPABILITY`，而不是让
 * 类型在编译期把宿主卡死。
 */

/**
 * 会话身份。由 native 分配，从 1 开始，进程内不复用。
 *
 * 它是**不透明句柄**，不是 pid，也不是 fd。协议层继续把它当 `number` 透传，
 * 这样从 `WeQ/packages/protocol` 逐字搬来的 161 个 spec 文件不需要改签名。
 */
export type SessionId = number;

/**
 * 会话的在线归属。
 *
 * - `1`（借用）：账号的在线状态由外部（QQ 本体）维持。本会话只持有自己的连接，
 *   不发 `SsoInfoSync`、不起心跳；关闭时不发 `UnRegister`。
 * - `2`（自建）：本会话拥有账号的在线状态。连接后必须完成 `SsoInfoSync`，
 *   启动心跳，并等待首屏 `InfoSyncPush` 收敛后才算 `online`。
 *
 * 不要在 `sendPacket` 的签名 mode（2/3）上复用它；两者语义无关。
 */
export type SessionMode = 1 | 2;

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
 * mode 1 / mode 2 都需要它：`sec_sign` 只能靠 wrapper 算。`sec_extra` / `sec_token`
 * 的输入在 {@link SsoSessionConfig} 里（`qua` / `secToken`）。
 */
export interface SignerPaths {
  /** QQ 的 `wrapper.node` 绝对路径；null = 只能发不需要签名的命令。 */
  wrapperPath: string | null;
  signCoreRva?: number | null;
  vmRva?: number | null;
}

/**
 * 一条 SSO 会话的物料（对应 nt_helper 的 `SsoSessionConfig`）。
 *
 * **来源不进类型**：扫描、`quickLogin`、`qrLogin` 产出的都是这一份结构。
 * 「不许把扫描物料用于自建上线」是调用纪律，由 native 的 `openSession`
 * 前置检查（QQ 是否在线）兜底，而不是靠字段区分。
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
 * 快速登录入参（对应 nt_helper 的 `QuickLoginOptions`）。
 *
 * `a1` 是**唯一需要长期持久化的凭据**；a2/d2/d2Key 是它的派生物，运行期易失。
 */
export interface QuickLoginOptions {
  uin: string;
  a1: Uint8Array;
  guid: string;
  /** 账号 uid；登录两步不需要，但 `0xcde_2` 与 SSO reserved tag 16 会带。 */
  uid?: string | null;
  appId?: number;
  subAppId?: number;
  /** 登录命令签名用的 `wrapper.node`；缺省时 `quickLogin` 会因未签名被拒。 */
  wrapperPath?: string | null;
  /**
   * 设备类型串（`Linux` / `Mac` / `Windows`）与 `NTLoginPlatform`
   * （7 / 5 / 4）。缺省由调用方按 `device.os` 推导；native 侧两者必填。
   */
  os?: string;
  platform?: number;
  qua?: string | null;
  clientVersion?: string | null;
  deviceName?: string | null;
  kernelVersion?: string | null;
  /** 传了就同连接发 `0xcde_2` 取数据库密钥；bot 不读 QQ 库，**永不传**。 */
  keyMeta?: unknown;
}

/**
 * 快登（`quickLogin`）过程中的进度事件。
 *
 * native 的 `QuickLoginEvent` 会把 `unusualDeviceCheckSig` / `qrImage` 这类
 * **认证物料**一并交出来；这里只保留「现在进行到哪一步、要对用户说什么」，
 * 物料不进这一层 —— 上层没有它们的用处，多传一次就多一个泄漏面。
 *
 * `kind` 的语义：
 *
 * - `state`：阶段变化（`key-exchange` / `easy-login` / `unusual-device-wait` …）；
 * - `unusual-device`：服务端把当前设备判成异常设备，**需要用户在手机上点
 *   「确认登录」**；native 会自己轮询确认结果，调用方只需要把这句话显示出来；
 * - `qr-state`：等待确认期间的状态回显（`waiting-confirm` / `confirmed` …）；
 * - `info`：其它提示。
 */
export interface LoginProgressEvent {
  kind: 'state' | 'unusual-device' | 'qr-state' | 'info';
  /** 阶段名，如 `easy-login`、`unusual-device-wait`。 */
  state?: string;
  /** 面向用户的一句话；`unusual-device` 一定有值。 */
  message: string;
}

export interface QuickLoginResult {
  uin: string;
  /**
   * 账号 uid（`u_...`）。
   *
   * native 从 classic `0x810` 应答的 TLV `0x543`
   * （`ThirdPartyLoginResponse.common_info.rsp_nt.uid`）回传；二维码登录会带，
   * NT EasyLogin 正常不回传。取不到时调用方回退到 vault / 账号配置。
   */
  uid?: string;
  /**
   * 登录过程中服务端下发的新 a1（来自 `0x18` / `0x106` / EasyLogin）。
   * 没轮换时为 null / 省略；调用方拿到后应写回 vault。
   */
  a1?: Uint8Array | null;
  a2: Uint8Array;
  d2: Uint8Array;
  d2Key: Uint8Array;
  /** 顺路取到的 Web 凭据：域名 → `p_skey`。 */
  pskey?: Record<string, string> | null;
}

/**
 * 打开一个会话。这是 mode 1 / mode 2 唯一的汇聚点。
 *
 * - `session` 是票据，来源不参与判断；
 * - `mode` 决定是否注册 + 心跳；
 * - `signer` 两种模式都需要；
 * - `device` / `wireProfile` 只有 mode 2 需要（`SsoInfoSync` 的 RegisterInfo）。
 */
export interface OpenSessionOptions {
  session: SsoSessionConfig;
  mode: SessionMode;
  signer: SignerPaths;
  /** mode 2 必填；mode 1 忽略。 */
  device?: DeviceProfile;
  /** wire 档位名（见 TODO「wire profile」）。mode 2 可选。 */
  wireProfile?: string;
  /**
   * mode 2 的 `verify_file` 上报参数（`trpc.o3.report.Report.SsoReport`）。
   *
   * 留空 = native 按平台给默认清单，仍然每 3600 s 上报一次。mode 1 忽略：
   * 那条连接的上报归 QQ 本体，我们再报一遍等于同一设备出现两个客户端。
   */
  verifyFile?: VerifyFileOptions;
}

/**
 * `verify_file` 上报参数（对应 nt_helper 的 `VerifyFileOptions`）。
 *
 * 上报的路径**不需要**对应真实文件 —— 服务端没有独立渠道核实客户端磁盘布局。
 * 宿主能探到真实安装位置时（`@weqbot/node` 的 `qq-paths`）喂真值更自然；
 * 探不到就整项省略，交给 native 的平台默认。
 */
export interface VerifyFileOptions {
  /**
   * 四类受检文件的标记，顺序固定为
   * `application.asar` / `major.node` / `package.json` / `wrapper.node`。
   * 取值只用 `"0"`（缺失）或 `"1"`（存在），必须恰好 4 项。
   */
  fileMarks?: string[];
  /** 上报的文件路径清单（顺序即上报顺序）。 */
  paths?: string[];
  /** 上报的可执行文件路径。 */
  binaryPath?: string;
  /** 注册成功后是否立刻发一条（之后仍按 3600 s 周期）。默认 `false`。 */
  sendOnRegister?: boolean;
}

/** `openSession` 的结果。 */
export interface OpenedSession {
  /** 发给 `sendPacket` / `sendOidbPacket` 的不透明句柄。 */
  sessionId: SessionId;
  uin: string;
  uid: string;
  mode: SessionMode;
  /**
   * mode 1：`open`（连接已建立或可懒建立，账号在线状态不归我们）；
   * mode 2：`online`（注册成功且首屏同步已收敛）。
   */
  state: 'open' | 'online';
  /** mode 2 是否已被服务端接受 `SsoInfoSync`；mode 1 恒 false。 */
  registered: boolean;
  /** mode 2 是否已完成 `InfoSyncPush` 首屏同步；mode 1 恒 false。 */
  synced: boolean;
}

/** 会话的运行时快照，诊断 / 控制通道用。 */
export interface SessionInfo {
  sessionId: SessionId;
  uin: string;
  uid: string;
  mode: SessionMode;
  state: 'open' | 'online' | 'closed';
  registered: boolean;
  synced: boolean;
  /** 最近一次 native 上报状态变化的时间（ms）。 */
  lastEventAt: number | null;
}

/**
 * 服务端推送的一帧。
 *
 * **native 不解 protobuf**：只剥 SSO 头、解密、把 `(command, body)` 原样交出来。
 * 解包在 `@weqbot/protocol/push`，这样新增推送类型不需要动 native。
 */
export interface PushFrame {
  sessionId: SessionId;
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
export type PushSinkError = (error: Error) => void;

/**
 * 原生侧主动报告的会话状态变化。
 *
 * sink 对两种 mode 都可用；mode 1 通常不会收到 `registered` / `synced` /
 * `heartbeat`，因为那些行为只在 mode 2 里发生。
 */
export type SessionStatusEvent =
  | { kind: 'registered'; sessionId: SessionId; ts: number }
  /** 首屏 `InfoSyncPush` 收敛，可以对外报在线。 */
  | { kind: 'synced'; sessionId: SessionId; ts: number }
  | { kind: 'heartbeat'; sessionId: SessionId; ts: number; rttMs?: number }
  | { kind: 'reconnecting'; sessionId: SessionId; attempt: number; ts: number }
  | { kind: 'reconnected'; sessionId: SessionId; ts: number }
  | { kind: 'kicked'; sessionId: SessionId; ts: number; reason?: string }
  | { kind: 'closed'; sessionId: SessionId; ts: number; reason?: string }
  /** TS 侧消费太慢，native 丢了帧（有界队列）。 */
  | { kind: 'sink_overflow'; sessionId: SessionId; ts: number; dropped: number };

/** FTF → TTF 字体转换参数（对应 native 的 `ConvertFontOptions`）。 */
export interface ConvertFontOptions {
  /** 彩色字体资源目录。 */
  assetsDir?: string;
  /** 是否生成彩色字形。 */
  color?: boolean;
  /** 参与彩色化的字符集。 */
  colorChars?: string;
  /** 是否跑 OTS 校验。 */
  checkOts?: boolean;
}

/**
 * 原生端口。
 *
 * 所有方法都是 `Promise`（跨 napi 边界），所有字节参数都是 `Uint8Array`
 * （`adaptNativeBinding` 会转成 `Buffer` 交给真 native）。
 */
export interface NativePort {
  // ── 发包（两种 mode 共用） ────────────────────────────────────────────────
  sendPacket(
    sessionId: SessionId,
    cmd: string,
    body: Uint8Array,
    needSign?: boolean | null,
    signMode?: number | null,
  ): Promise<Uint8Array>;

  sendOidbPacket(
    sessionId: SessionId,
    command: number,
    subCommand: number,
    body: Uint8Array,
    isUid: boolean,
    needSign: boolean,
    signMode?: number | null,
  ): Promise<Uint8Array>;

  // ── 凭据换票（进程无关） ──────────────────────────────────────────────────
  /**
   * 快速登录。`onEvent` 交出来的是 native 原始事件（含认证物料与二维码字节）；
   * 需要「现在进行到哪一步」时用 {@link parseLoginProgress} 归一，不要在这一层
   * 自己解析 `kind` —— 形状随 native 版本漂移。
   */
  quickLogin?(
    options: QuickLoginOptions,
    onEvent?: (error: Error | null, event: unknown) => unknown,
  ): Promise<QuickLoginResult>;

  // ── 会话生命周期 ─────────────────────────────────────────────────────────
  /** 打开一个会话；mode 2 内部完成连接 → 注册 → 心跳 → 首屏同步。 */
  openSession?(options: OpenSessionOptions): Promise<OpenedSession>;
  /** 关闭会话；mode 2 会先发 `UnRegister`，两种 mode 都释放连接与句柄。 */
  closeSession?(sessionId: SessionId, reason?: string): Promise<void>;
  /** 查询会话快照；不存在返回 null。 */
  getSession?(sessionId: SessionId): Promise<SessionInfo | null>;
  /**
   * 原地替换会话的 `SecToken`；不重连、不重新登录。
   *
   * 下一个需要签名的包立即使用新值。用于长跑的 mode 2 在 token 到期前轮换
   * （QQ 客户端 token 缓存 48h，24h 轮换留足余量）。
   */
  setSecToken?(sessionId: SessionId, token: string): Promise<boolean>;
  /**
   * 订阅推送帧；返回取消订阅函数。
   *
   * `onError` 用于 native 侧推送通道自身出错（解码失败 / 队列错误），
   * 与帧数据无关。不传时错误只进 native 日志。
   */
  attachPushSink?(
    sessionId: SessionId,
    sink: PushSink,
    onError?: PushSinkError,
  ): Promise<() => void>;
  /** 订阅状态变化；返回取消订阅函数。 */
  attachStatusSink?(
    sessionId: SessionId,
    sink: (event: SessionStatusEvent) => void,
  ): Promise<() => void>;

  // ── 签名 / 诊断 ─────────────────────────────────────────────────────────
  /**
   * 找**已安装** QQ 的 `wrapper.node`（进程层能力，与 SSO 无关）。
   *
   * 宿主 / TS 拿到路径后作为 `openSession` 的 `signer.wrapperPath` 传入；
   * native 的 SSO 层只消费路径，不做平台探测。
   *
   * native 的原始导出 `resolveQqWrapperPath` 是**同步**的；适配层统一包成
   * Promise，调用方不需要关心。
   */
  resolveWrapperPath?(): Promise<string | null>;
  /**
   * QQ 本体是否在线（按 `nt_msg.db` 的文件锁持有进程判断）。
   *
   * mode 2 必须由调用方在 `openSession` 前检查：native 的 `openSession` 只查
   * 自己进程内的 Owned 会话，不查 QQ 本体。`dbPath` 是账号的 `nt_msg.db`
   * 绝对路径，由宿主 / 配置提供；native 不猜数据目录。
   */
  isQqLoggedIn?(dbPath: string): Promise<boolean>;
  warmupSigner?(wrapperPath: string): Promise<{ signCoreRva: number; vmRva: number }>;
  getBuildInfo?(): NativeBuildInfo;

  // ── 字体转换（进程层能力，与 SSO 无关） ──────────────────────────────
  /** 异步版本：把 `inputPath` 的 FTF 转成 `outputPath` 的 TTF。 */
  convertFontAsync?(
    inputPath: string,
    outputPath: string,
    options?: ConvertFontOptions,
  ): Promise<string>;
  /** 同步版本；大字体可能阻塞事件循环，优先用 `convertFontAsync`。 */
  convertFont?(inputPath: string, outputPath: string, options?: ConvertFontOptions): string;
  /** 字体转换管线的版本号。 */
  getFontPipelineVersion?(): number;
}
