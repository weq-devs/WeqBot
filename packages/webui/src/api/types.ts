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
  /** QQ 本体是否在线；`undefined` 表示没配置 dbPath、无法判断。 */
  qqRunning?: boolean;
}

export interface LoginAccount {
  uin: string;
  uid: string;
  nickname?: string;
  avatarUrl?: string;
  lastLoginAt?: number;
  hasA1: boolean;
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
  /** 用本机 `login.db` 的账号登录；成功后直接上线。 */
  start(uin: string): Promise<void>;
  /** 起一次扫码（45s 硬超时，重复调用复用同一次）。 */
  startQr(): Promise<QrSnapshot>;
  cancelQr(): Promise<void>;
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

export interface Overview {
  phase: ConsolePhase;
  account?: OverviewAccount;
  messages: { received: number; sent: number };
  heartbeat: { samples: number[]; medianMs?: number };
  networks: NetworkSnapshot[];
  actions: { registered: number; skipped: number };
  onebotPort?: number;
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

// ─────────────────────────── 事件流 ───────────────────────────

export interface ConsoleStateEvent {
  phase?: ConsolePhase;
  at: number;
  detail?: string;
  qr?: QrSnapshot;
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
  login: LoginApi;
  overview: OverviewApi;
  network: NetworkApi;
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
