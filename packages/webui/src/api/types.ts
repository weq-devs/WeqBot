/**
 * WebUI 与 `@weqbot/node` 控制台服务之间的契约（HTTP + SSE）。
 *
 * 后端实现见 `packages/node/src/webui/`。页面只 import 这里与 `index.ts`，
 * 不直接拼 URL —— 端点改名时只改这两个文件。
 */

/** `POST /api/auth/session` 的结果。 */
export type SessionResult =
  | { ok: true }
  /** 401 `TOKEN_INVALID`：令牌不对，还剩几次机会。 */
  | { ok: false; reason: 'invalid'; remainingAttempts: number }
  /** 429 `RATE_LIMITED`：失败太多次，锁定中。 */
  | { ok: false; reason: 'locked'; retryAfterMs: number }
  /** 请求根本没到服务端（进程退出 / 端口变了）。 */
  | { ok: false; reason: 'unreachable' };

export interface AuthApi {
  /** `POST /api/auth/session {token, remember}`：服务端写 HttpOnly cookie。 */
  createSession(token: string, remember?: boolean): Promise<SessionResult>;
  /** `GET /api/auth/session`：刷新页面后确认会话是否仍有效。 */
  getSession(): Promise<{ authenticated: boolean }>;
  /** `DELETE /api/auth/session`：退出控制台 —— 只清 WebUI 会话，**不让 QQ 账号下线**。 */
  deleteSession(): Promise<void>;
}

// ─────────────────────────── 登录 ───────────────────────────

export interface LoginEnvironment {
  platform: string;
  qqExe: string | null;
  installRoot: string | null;
  wrapperNode: string | null;
  majorNode: string | null;
  dataRoot: string | null;
  loginDbs: string[];
  client?: { appid: string; qua?: string; version?: string; build?: string };
  /** `resources/app/package.json` 的版本（native 解析失败时的第二条来源）。 */
  version?: string;
  /** 每一项是怎么来的：手动 / 环境变量 / 自动探测。 */
  sources?: {
    dataRoot?: 'override' | 'env' | 'detected';
    qqExe?: 'override' | 'env' | 'protocol' | 'registry' | 'spotlight' | 'detected';
  };
  /** 本次「QQ 本体在线」预检用的 `nt_msg.db`。 */
  qqDbPath?: string;
  /** QQ 本体是否在线；`undefined` 表示拿不到 dbPath、无法判断。 */
  qqRunning?: boolean;
}

/** 凭据来源：我们自己的 vault，或 QQ 本体写的 `login.db`。 */
export type AccountSource = 'vault' | 'login-db';

/**
 * 账号分组（服务端严格隔离）。
 *
 * - `local`：本机账号。a1 每次从 `login.db` 现解，uid / guid 复用本机的；
 *   上线后轮换的 a1 会写回 `login.db`。
 * - `self`：自主账号。guid 是首次扫码时生成的随机值并持久化，之后一直复用它。
 *
 * 两组不能混：guid 混用会让服务端把自主账号当成这台机器上的 QQ。
 */
export type AccountGroup = 'local' | 'self';

/**
 * 可以上线的账号（按组列出）。
 *
 * 服务端只返回有 a1 的账号 —— 没有 a1 的行点进去必然失败，不做成可点条目。
 * `group` 决定用哪份设备身份，`source` 只解释凭据是哪来的。
 */
export interface LoginAccount {
  uin: string;
  uid: string;
  source: AccountSource;
  group: AccountGroup;
  nickname?: string;
  avatarUrl?: string;
  lastLoginAt?: number;
  /**
   * 这个账号在 **QQ 本体**里是否在线（QQ 进程持有它的 `nt_msg.db`）。
   *
   * `undefined` 表示服务端探测不到（推不出 dbPath / native 缺能力），页面不能
   * 把「不知道」显示成「不在线」。登录页会轮询账号列表，徽标随之更新。
   */
  qqOnline?: boolean;
}

/** `POST /api/login/start` 的结果。 */
export interface LoginStartResult {
  phase: ConsolePhase;
  /** 登录前结束的本机 QQ 进程数（QQ 本体正用着这个账号时不为 0）。 */
  endedQq: number;
}

// ─────────────────────────── 有头模式 ───────────────────────────

/**
 * 读取运行中 QQ 的内存要多少权限。
 *
 * - `none`：不需要（Windows 同用户进程）；
 * - `sudo`：要一次管理员密码（linux / darwin）；
 * - `uac`：只能靠「以管理员身份运行」（Windows 被策略拦住时）。
 */
export type ElevationMechanism = 'none' | 'sudo' | 'uac';

export interface ElevationState {
  platform: string;
  /** 控制台进程已经是 root。 */
  elevated: boolean;
  /** sudo 凭据还在缓存里：这次多半不用再输密码。 */
  cached: boolean;
  mechanism: ElevationMechanism;
  /** Linux 的 `yama/ptrace_scope`；读不到时没有这一项。 */
  ptraceScope?: number;
  /** 服务端给的一句话说明。 */
  hint: string;
}

/** 一个正在运行的 QQ 进程。`uin` 缺失 = 认不出账号身份，不能接入。 */
export interface QqInstance {
  pid: number;
  uin?: string;
  uid?: string;
  nickname?: string;
  avatarUrl?: string;
  /** 运行中 QQ 的版本（取自它的 `major.node`）。 */
  qqVersion?: string;
  attachable: boolean;
  /** 不能接入时的一句话原因。 */
  note?: string;
}

export interface AttachSnapshot {
  elevation: ElevationState;
  instances: QqInstance[];
}

/** `POST /api/login/attach` 的结果。 */
export interface AttachStartResult {
  phase: ConsolePhase;
  pid: number;
}

export interface AttachApi {
  /** 正在运行的 QQ 实例 + 提权状态。 */
  instances(): Promise<AttachSnapshot>;
  /**
   * 有头接入：借用运行中 QQ 的会话（不改动 QQ，也不结束它）。
   *
   * 首次可能抛 `ApiError(409, 'ELEVATION_REQUIRED')` —— 拿到密码后再调一次。
   */
  start(uin: string, options?: { pid?: number; password?: string }): Promise<AttachStartResult>;
}

export type QrState =
  | 'waiting-scan'
  | 'waiting-confirm'
  | 'confirmed'
  | 'expired'
  | 'canceled'
  | 'invalid';

export interface QrSnapshot {
  /** 二维码 PNG（base64，不带 `data:` 前缀）。 */
  image?: string;
  url?: string;
  state: QrState | string;
  uin?: string;
  expiresAt: number;
  error?: string;
}

export interface LoginApi {
  environment(): Promise<LoginEnvironment>;
  accounts(): Promise<LoginAccount[]>;
  /**
   * 用账号凭据登录；成功后直接上线。
   *
   * `group` 指定用哪一组：列表里同一 uin 可能在两组里各有一条，点哪条就用哪组。
   * 省略时服务端按「有自主凭据就自主」推断。
   */
  start(uin: string, options?: { group?: AccountGroup }): Promise<LoginStartResult>;
  /** 起一次扫码（45s 硬超时，重复调用复用同一次）。 */
  startQr(): Promise<QrSnapshot>;
  cancelQr(): Promise<void>;
  /** 有头模式（借运行中 QQ 的会话）。 */
  attach: AttachApi;
}

// ─────────────────────────── 总览 ───────────────────────────

export type ConsolePhase = 'no-account' | 'starting' | 'online' | 'offline';

export interface NetworkSnapshot {
  kind: 'http-server' | 'http-client' | 'ws-server' | 'ws-client';
  name: string;
  endpoint: string;
  state: 'listening' | 'connected' | 'connecting' | 'stopped' | 'error';
  port?: number;
  clients: number;
  error?: string;
}

export interface OverviewAccount {
  uin: string;
  uid: string;
  nickname: string;
  avatarUrl: string;
  onlineSince?: number;
  startedAt: number;
  device?: { os: string; appId: number; subAppId: number; qua: string; clientVersion: string };
  reconnects: number;
  secTokenRotatesAt?: number;
  sessionId?: number;
}

export interface SystemSnapshot {
  platform: string;
  arch: string;
  cpus: number;
  loadAvg: number[];
  uptimeSec: number;
  processUptimeSec: number;
  memory: { rss: number; heapUsed: number; heapTotal: number };
  systemMemory: { total: number; free: number };
  storage?: { path: string; total: number; free: number };
  logDir: string | null;
}

export interface Overview {
  phase: ConsolePhase;
  account?: OverviewAccount;
  messages: { received: number; sent: number };
  heartbeat: { samples: number[]; medianMs?: number };
  networks: NetworkSnapshot[];
  actions: { registered: number; skipped: number };
  onebotPort?: number;
  /** 旧版服务端 / 嵌入宿主可能没有设备指标；缺失时总览隐藏设备卡。 */
  system?: SystemSnapshot;
}

export interface OverviewApi {
  get(): Promise<Overview>;
}

// ─────────────────────────── 网络配置 ───────────────────────────

export type MessageFormat = 'array' | 'string';
export type WsRole = 'Api' | 'Event' | 'Universal';

interface NetworkBase {
  name: string;
  enabled?: boolean;
  accessToken?: string;
  messageFormat: MessageFormat;
  reportSelfMessage: boolean;
}

export interface HttpServerNetwork extends NetworkBase {
  kind: 'httpServers';
  host?: string;
  port: number;
  path?: string;
  enableWebSocket?: boolean;
}

export interface HttpClientNetwork extends NetworkBase {
  kind: 'httpClients';
  url: string;
  timeoutMs?: number;
}

export interface WsServerNetwork extends NetworkBase {
  kind: 'wsServers';
  host?: string;
  port: number;
  path?: string;
  role?: WsRole;
}

export interface WsClientNetwork extends NetworkBase {
  kind: 'wsClients';
  url: string;
  role?: WsRole;
  reconnectIntervalMs?: number;
}

export type NetworkConfig =
  | HttpServerNetwork
  | HttpClientNetwork
  | WsServerNetwork
  | WsClientNetwork;

export interface OneBotConfig {
  networks: {
    httpServers: HttpServerNetwork[];
    httpClients: HttpClientNetwork[];
    wsServers: WsServerNetwork[];
    wsClients: WsClientNetwork[];
  };
  qzone?: boolean;
  qzoneDomain?: string;
}

export interface NetworkApi {
  get(): Promise<OneBotConfig | undefined>;
  /** 保存并热重启 OneBot 适配器（会话不动）；失败会回滚旧配置。 */
  save(config: OneBotConfig): Promise<OneBotConfig>;
}

// ─────────────────────────── 日志 ───────────────────────────

export interface LogEntry {
  ts: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  scope: string;
  msg: string;
  fields?: Record<string, unknown>;
}

export interface ActionCallEntry {
  ts: number;
  action: string;
  params: Record<string, unknown>;
  retcode: number;
  status: 'ok' | 'failed';
  latencyMs: number;
  transport: 'ws' | 'http' | 'webui';
  client: string;
}

export interface PushEventEntry {
  ts: number;
  type: string;
  kind: string;
  peer?: string;
  summary: string;
}

export interface ActionStats {
  total: number;
  ok: number;
  failed: number;
  byAction: Array<{ action: string; count: number; failed: number }>;
  byRetcode: Array<{ retcode: number; count: number }>;
  latency: { p50: number; p95: number; max: number };
  transports: Record<string, number>;
}

export interface LogStats {
  actions: ActionStats;
  logs: { total: number };
  events: { total: number };
}

export type StreamName = 'logs' | 'actions' | 'events';

export interface LogsApi {
  stats(): Promise<LogStats>;
  /** 订阅一条流；返回取消函数。断线由浏览器自动重连（SSE 原生行为）。 */
  stream(
    stream: StreamName,
    handlers: { onEntry(entry: unknown): void; onError?(): void },
  ): () => void;
}

// ─────────────────────────── 设置 ───────────────────────────

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

export interface SettingsSnapshot {
  environment: LoginEnvironment;
  /** 当前在线账号；没有时 `null`（OneBot 配置按账号隔离）。 */
  account?: { uin: string } | null;
  /** 旧版服务端可能没有这一块。 */
  onebot?: { qzone: boolean };
  /** 当前手动指定的 QQ 路径（设置页预填输入框）；没设就是 `null`。 */
  qqPaths?: { installDir: string | null; dataDir: string | null };
  logging: {
    /** 当前落盘目录；`null` 表示关闭落盘。 */
    dir: string | null;
    /** 终端级别。 */
    level: LogLevel;
    /** 文件级别（默认 debug）。 */
    fileLevel: LogLevel;
    files: Array<{ name: string; size: number }>;
  };
  runtime: {
    platform: string;
    arch: string;
    node: string;
    pid: number;
    uptimeSec: number;
    configPath: string | null;
  };
}

export interface SettingsApi {
  get(): Promise<SettingsSnapshot>;
  /**
   * `logDir` 为空串 / `off` / `null` 表示关闭落盘。
   *
   * `qqPaths` 里的 `null` 或空串表示清除手动覆盖、回到自动探测；
   * `refresh` 为 true 时跳过路径缓存重新探测。
   */
  update(patch: {
    logDir?: string | null;
    level?: LogLevel;
    qzone?: boolean;
    qqPaths?: { installDir?: string | null; dataDir?: string | null };
    refresh?: boolean;
  }): Promise<SettingsSnapshot>;
}

// ─────────────────────────── 调试 ───────────────────────────

export interface ActionInfo {
  name: string;
  summary: string;
  group: string;
  write: boolean;
}

/** `GET /api/actions`：列表 + 为空时的原因（账号阶段 / OneBot 是否启用）。 */
export interface ActionsSnapshot {
  actions: ActionInfo[];
  phase: ConsolePhase;
  onebot: boolean;
}

export interface ActionRunResult {
  status: 'ok' | 'failed';
  retcode: number;
  data: unknown;
  wording?: string;
  latencyMs: number;
}

export interface DebugApi {
  actions(): Promise<ActionsSnapshot>;
  run(name: string, params: Record<string, unknown>): Promise<ActionRunResult>;
}

// ─────────────────────────── 账号 ───────────────────────────

export interface AccountApi {
  /** 账号下线（发 UnRegister）；`forgetCredential` 同时删本机凭据。 */
  logout(options?: { forgetCredential?: boolean }): Promise<void>;
}

// ─────────────────────────── 健康检查 ───────────────────────────

/** `GET /api/health`：页面据此判断控制台进程是否还活着。 */
export interface HealthSnapshot {
  ok: boolean;
  /** 服务端应答时刻（ms）。断开后页面用最后一次成功值冻结「在线时长」。 */
  at: number;
  pid: number;
  uptimeSec: number;
}

export interface HealthApi {
  /** 免鉴权：后端重启后 cookie 失效，健康状态仍然要能被看见。 */
  check(): Promise<HealthSnapshot>;
}

// ─────────────────────────── 事件流 ───────────────────────────

/**
 * 登录进度：上线期间的实时说明。
 *
 * `unusual-device` 是重点 —— 服务端把设备判成异常设备时，native 会等用户在手机
 * 上点「确认登录」，最长 45 秒；没有这条事件页面就只剩一个转圈。
 */
export interface LoginProgressEvent {
  kind: 'state' | 'unusual-device' | 'qr-state' | 'info';
  state?: string;
  /** 面向用户的一句话，`unusual-device` 一定有值。 */
  message: string;
}

export interface ConsoleStateEvent {
  phase?: ConsolePhase;
  at: number;
  detail?: string;
  qr?: QrSnapshot;
  /** 需要页面主动反应的一次性信号（`phase` 表达不了「为什么回登录页」）。 */
  notice?: ConsoleNotice;
  /** 上线进度（登录页在 `starting` 期间显示）。 */
  progress?: LoginProgressEvent;
}

/** 页面需要跳转 / 弹提示的信号。 */
export interface ConsoleNotice {
  kind: 'a1-expired';
  uin: string;
}

export interface EventsApi {
  /** 订阅控制台事件（阶段迁移 / 扫码进度）。 */
  subscribe(handlers: {
    onConsole(event: ConsoleStateEvent): void;
    onEntry?(stream: StreamName, entry: unknown): void;
    onError?(): void;
  }): () => void;
}

export interface Api {
  auth: AuthApi;
  /** 后端进程健康性（前端轮询，断开时停止展示在线时长）。 */
  health: HealthApi;
  login: LoginApi;
  overview: OverviewApi;
  network: NetworkApi;
  settings: SettingsApi;
  logs: LogsApi;
  debug: DebugApi;
  account: AccountApi;
  events: EventsApi;
}

/** 后端返回的业务错误（`{code, message}`）。 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'ApiError';
  }
}
