/**
 * WebUI 控制台运行时（W3）：一个进程一个账号，账号可以在登录页选。
 *
 * 与 `runSidecar` 的分工：
 *
 * - sidecar 的账号由宿主 spawn 时决定，凭据从控制通道进来；
 * - 控制台的账号由**用户在浏览器里选**，凭据来自本机 `login.db` 或扫码。
 *
 * 状态机只有四个：`no-account`（还没绑账号）→ `starting` → `online` → `offline`。
 * 进程本身不因为账号下线而退出 —— 用户可以回到登录页换一个账号（单账号：换账号
 * 必须先下线旧账号，`startAccount` 会拒绝在线时切号）。
 *
 * 凭据纪律：
 *
 * - a1 只进 `CredentialVault`，**不进任何 HTTP 响应**；
 * - `login.db` 解出来的 `a1Payload` 只在 `startAccount` 的局部变量里活一次；
 * - 日志里出现 a1 / skey / pskey 一律由 `Observability` 的脱敏兜底。
 */

import { statfsSync } from 'node:fs';
import { arch, cpus, freemem, loadavg, totalmem, uptime } from 'node:os';
import { getLogDirectory, isWeqBotError, TypedEventBus, type Logger } from '@weqbot/common';
import {
  createBot,
  type Bot,
  type BotConfig,
  type BotOneBotConfig,
  type BotSnapshot,
} from '@weqbot/bot';
import type { BotEventMap, CredentialVault, StoredAccount } from '@weqbot/session';
import type { DeviceProfile, NativePort, QuickLoginResult, RawNativeBinding } from '@weqbot/wire';
import { HttpError } from './http-util';
import type { Observability } from './observability';
import { findNtMsgDb } from './qq-account';
import { clearQqHintsCache, ensureQqHints } from './qq-detect';
import { discoverQqPaths, LOGIN_DB_KEY, type QqPathOverrides, type QqPaths } from './qq-paths';

export type ConsolePhase = 'no-account' | 'starting' | 'online' | 'offline';

export interface ConsoleAccount {
  uin: string;
  uid: string;
  nickname?: string;
  avatarUrl?: string;
  lastLoginAt?: number;
  /** 本机 vault 里是否有这个账号的 a1。 */
  hasA1: boolean;
}

export interface ConsoleOverview {
  phase: ConsolePhase;
  account?: {
    uin: string;
    uid: string;
    nickname: string;
    avatarUrl: string;
    /** 进入在线状态的时刻（ms）。 */
    onlineSince?: number;
    /** 本次进程启动时刻。 */
    startedAt: number;
    device?: DeviceProfile;
    reconnects: number;
    secTokenRotatesAt?: number;
    sessionId?: number;
  };
  /** 收 / 发消息计数（本进程）。 */
  messages: { received: number; sent: number };
  /** 心跳 RTT：最近 N 次与中位数。 */
  heartbeat: { samples: number[]; medianMs?: number };
  /** 同 `bot.onebot.networks()`；OneBot 未启动时是空数组。 */
  networks: ReturnType<NonNullable<Bot['onebot']>['networks']>;
  actions: { registered: number; skipped: number };
  onebotPort?: number;
  /** 设备状态：进程内存、系统内存、磁盘与运行时长。 */
  system: ConsoleSystem;
}

export interface ConsoleSystem {
  platform: NodeJS.Platform;
  arch: string;
  cpus: number;
  loadAvg: number[];
  /** 系统运行时长（秒）。 */
  uptimeSec: number;
  /** 本进程运行时长（秒）。 */
  processUptimeSec: number;
  memory: {
    /** 进程常驻内存（字节）。 */
    rss: number;
    heapUsed: number;
    heapTotal: number;
  };
  systemMemory: { total: number; free: number };
  /** 日志目录所在文件系统；拿不到时省略（不影响其它指标）。 */
  storage?: { path: string; total: number; free: number };
  logDir: string | null;
}

export interface LoginEnvironment {
  platform: NodeJS.Platform;
  qqExe: string | null;
  installRoot: string | null;
  wrapperNode: string | null;
  majorNode: string | null;
  dataRoot: string | null;
  loginDbs: string[];
  /** `major.node` 解析出的客户端身份；缺 major.node 时为 undefined。 */
  client?: { appid: string; qua?: string; version?: string; build?: string };
  /** `resources/app/package.json` 的版本；native 解析失败时的第二条来源。 */
  version?: string;
  /** 每一项是怎么来的（设置页显示「手动 / 环境变量 / 自动」）。 */
  sources?: QqPaths['sources'];
  /** 这次预检用的 `nt_msg.db`（显式配置或从账号目录推导），供排障显示。 */
  qqDbPath?: string;
  /** QQ 本体是否在线（按 `nt_msg.db` 锁）；拿不到 dbPath 时 undefined。 */
  qqRunning?: boolean;
}

export interface ConsoleStateEvent {
  phase: ConsolePhase;
  at: number;
  /** 附加信息：状态迁移名 / 错误码。 */
  detail?: string;
}

export interface ConsoleOptions {
  native: NativePort;
  /** 原始绑定：登录页要用的进程层能力（login.db / major.node / 扫码）不经过 `NativePort`。 */
  binding: RawNativeBinding;
  vault: CredentialVault;
  /**
   * `--config` 读出来的配置；账号由登录页决定，所以 `account` 不在这里。
   *
   * **可变**：网络页保存后 `runWebUi` 会直接改这一份，下次上线 / 热重启读到新值。
   */
  config: Omit<BotConfig, 'account'>;
  /** 按账号保存的 OneBot 配置；登录页切换账号时各用各的。 */
  onebotByUin?: Record<string, BotOneBotConfig>;
  /** 配置文件中出现过的 `qq.dbPath`（由调用方传入，用于「QQ 是否在线」）。 */
  qqDbPath?: string;
  /**
   * 用户在设置页 / 配置文件里手动指定的路径。优先级高于环境变量与自动探测。
   *
   * 可变：设置页保存时直接改这一份（见 `setQqPathOverrides`）。
   */
  qqPathsOverride?: QqPathOverrides | null;
  /** WebUI 自己的日志器：会挂上 `Observability.logSink`。 */
  logger: Logger;
  observability: Observability;
  /** 注入点：测试用假 Bot。 */
  botFactory?: (options: Parameters<typeof createBot>[0]) => Bot;
  /** 注入点：探测 QQ 路径（测试用来计数 / 短路真实磁盘）。 */
  discoverPaths?: () => Promise<QqPaths>;
  /** 路径缓存 TTL；默认 30 秒，测试可调小。 */
  qqPathsTtlMs?: number;
}

/** 二维码登录单飞的窗口：45 秒硬超时（V45），期间重复请求复用同一次。 */
const QR_TIMEOUT_MS = 45_000;

/**
 * 路径探测结果的有效期。
 *
 * 与 `login.db` 行缓存的 30 秒一致：QQ 升级 / 用户换目录之后不必重启进程，
 * 最迟半分钟内生效。探测本身有 disk `existsSync` + 一次性注册表查询，不便宜也不贵。
 */
const QQ_PATHS_TTL_MS = 30_000;

export interface QrSnapshot {
  /** 二维码 PNG（base64，不带 data: 前缀）。 */
  image?: string;
  /** 二维码内容 URL。 */
  url?: string;
  /** `waiting-scan` / `waiting-confirm` / `confirmed` / `expired` / `canceled` / `invalid`。 */
  state: string;
  /** 已确认时的 uin。 */
  uin?: string;
  /** 本次二维码的到期时刻（ms）。 */
  expiresAt: number;
  /** 失败原因（过期 / 取消 / 原生报错）。 */
  error?: string;
}

export class ConsoleRuntime {
  private readonly log: Logger;
  private readonly observability: Observability;
  private readonly botFactory: (options: Parameters<typeof createBot>[0]) => Bot;
  private readonly events = new TypedEventBus<BotEventMap & { console: ConsoleStateEvent }>();
  private bot: Bot | undefined;
  private phase: ConsolePhase = 'no-account';
  private startedAccount: string | undefined;
  private received = 0;
  private sent = 0;
  private readonly heartbeats: number[] = [];
  private qr: { snapshot: QrSnapshot; promise: Promise<QrSnapshot> } | undefined;
  /** `login.db` 行缓存（TTL 30s）：解密是同步 SQLite 打开，不该每个请求都跑一遍。 */
  private loginRowsCache: { rows: LoginRow[]; at: number } | undefined;
  private unsubscribers: Array<() => void> = [];
  /**
   * 路径探测结果缓存。TTL 与 `environment()` 的 30 秒一致：QQ 升级 / 用户换目录
   * 之后不必重启进程，最迟半分钟内生效。
   */
  private qqPathsCache: { value: QqPaths; at: number } | undefined;
  /** 同一时刻只跑一次探测（「重新检查」连点、登录页与设置页并发请求都会撞上）。 */
  private qqPathsPending: Promise<QqPaths> | undefined;
  /**
   * `login.db` 路径列表的镜像。
   *
   * `readLoginDbAccounts()` 是同步的（解密是同步 SQLite 打开），不能 `await`；
   * 由 `refreshLoginAccounts()` 预热后填进来，路径变了就清空。
   */
  private loginPathsCache: string[] | undefined;
  /** uin → OneBot 配置。内存镜像与配置文件同步，切换账号时读取。 */
  private readonly onebotByUin: Map<string, BotOneBotConfig>;

  constructor(private readonly options: ConsoleOptions) {
    this.log = options.logger;
    this.observability = options.observability;
    this.botFactory = options.botFactory ?? createBot;
    this.onebotByUin = new Map(Object.entries(options.onebotByUin ?? {}));
  }

  /** 当前账号（或指定账号）的 OneBot 配置；没有就返回 undefined（不跨账号借用）。 */
  oneBotConfigFor(uin: string | undefined = this.startedAccount): BotOneBotConfig | undefined {
    return uin ? this.onebotByUin.get(uin) : undefined;
  }

  /** 网络页 / 设置页保存后的内存镜像；下次这个账号上线直接生效。 */
  rememberOneBotConfig(uin: string, config: BotOneBotConfig): void {
    this.onebotByUin.set(uin, config);
  }

  get currentPhase(): ConsolePhase {
    return this.phase;
  }

  get currentBot(): Bot | undefined {
    return this.phase === 'online' || this.phase === 'starting' ? this.bot : undefined;
  }

  /** 已绑定的账号（`startAccount` 之后才有）。 */
  get boundUin(): string | undefined {
    return this.startedAccount;
  }

  /** 控制台事件（SSE 的 `state` / `qr` 之类）。 */
  get consoleEvents(): TypedEventBus<BotEventMap & { console: ConsoleStateEvent }> {
    return this.events;
  }

  // ─────────────────────────── 登录页 ───────────────────────────

  /**
   * 环境检查：QQ 安装 / 数据根 / wrapper / major / QQ 是否在线。
   *
   * 路径结果缓存 30 秒；`refresh` 为 true 时立即作废重算（设置页的「重新检查」）。
   */
  async environment(refresh = false): Promise<LoginEnvironment> {
    const paths = await this.paths(refresh);
    let client: LoginEnvironment['client'];
    if (paths.majorNode && this.options.binding.resolveAppidFromMajor) {
      try {
        const info = this.options.binding.resolveAppidFromMajor(paths.majorNode);
        client = {
          appid: String(info.appid),
          ...(info.qua ? { qua: info.qua } : {}),
          ...(info.version ? { version: info.version } : {}),
          ...(info.build ? { build: info.build } : {}),
        };
      } catch (cause) {
        this.log.warn('major.node 解析失败', { cause: messageOf(cause) });
      }
    }

    // 「QQ 本体在线」用哪个 nt_msg.db：显式配置优先，其次按当前账号推导。
    const qqDbPath = await this.ntMsgDbForBoundAccount(paths);
    let qqRunning: boolean | undefined;
    if (qqDbPath && this.options.native.isQqLoggedIn) {
      try {
        qqRunning = await this.options.native.isQqLoggedIn(qqDbPath);
      } catch (cause) {
        this.log.warn('isQqLoggedIn 失败', { cause: messageOf(cause) });
      }
    }

    return {
      platform: process.platform,
      qqExe: paths.qqExe,
      installRoot: paths.installRoot,
      wrapperNode: paths.wrapperNode,
      majorNode: paths.majorNode,
      dataRoot: paths.dataRoot,
      loginDbs: paths.loginDbs,
      ...(client ? { client } : {}),
      ...(paths.version ? { version: paths.version } : {}),
      ...(Object.keys(paths.sources).length > 0 ? { sources: paths.sources } : {}),
      ...(qqDbPath ? { qqDbPath } : {}),
      ...(qqRunning !== undefined ? { qqRunning } : {}),
    };
  }

  /**
   * 本机账号列表：`login.db` 解出来的行 + vault 里已有的凭据合并。
   *
   * **不返回 a1**。`hasA1` 只看 vault（`login.db` 的 `a1Payload` 不落盘，
   * 要用的时候在 `startAccount` 里现解）。
   */
  async accounts(): Promise<ConsoleAccount[]> {
    const vaultAccounts = await this.options.vault.list();
    const merged = new Map<string, ConsoleAccount>();
    for (const account of vaultAccounts) {
      merged.set(account.uin, {
        uin: account.uin,
        uid: account.uid,
        avatarUrl: avatarUrlOf(account.uin),
        hasA1: true,
        ...(account.lastOnlineAt ? { lastLoginAt: account.lastOnlineAt } : {}),
      });
    }

    await this.refreshLoginAccounts();
    for (const row of this.readLoginDbAccounts()) {
      const existing = merged.get(row.uin);
      merged.set(row.uin, {
        uin: row.uin,
        uid: row.uid,
        ...(row.userName ? { nickname: row.userName } : {}),
        // 头像统一走同源代理：页面的 CSP 不放行外网图片域名，而 login.db 里的
        // `avatarUrl`（thirdqq.qlogo.cn 带 k/kti 签名）需要服务端原样转发才有。
        avatarUrl: avatarUrlOf(row.uin),
        ...(row.lastLoginAt ? { lastLoginAt: row.lastLoginAt * 1000 } : {}),
        hasA1: existing?.hasA1 ?? Boolean(row.a1Payload),
      });
      // 代理用的上游 URL 留在服务端，不发给页面。
      if (row.avatarUrl) this.avatarSources.set(row.uin, row.avatarUrl);
    }

    return [...merged.values()].sort((a, b) => (b.lastLoginAt ?? 0) - (a.lastLoginAt ?? 0));
  }

  /**
   * 用本机 `login.db` 的账号登录。
   *
   * 顺序：解出 a1 → 写 vault（`a1Origin: 'login-db'`）→ `createBot().start()`。
   * `device` 取自 `major.node`，`guid` 取自数据根；两者缺一都明确失败，不猜。
   */
  async startAccount(uin: string): Promise<void> {
    if (this.phase === 'online' || this.phase === 'starting') {
      throw new HttpError(409, 'ALREADY_ONLINE', '已有账号在线，先退出登录再切换');
    }
    if (!/^[1-9]\d{4,19}$/.test(uin)) throw new HttpError(400, 'BAD_UIN', 'uin 不合法');

    const paths = await this.paths();
    const environment = await this.environment();

    // 1. 凭据：vault 优先，其次 login.db。
    let stored = await this.options.vault.get(uin);
    if (!stored || stored.a1.length === 0) {
      stored = await this.accountFromLoginDb(uin, paths, environment);
    } else {
      stored = await this.refreshDevice(stored, environment);
    }

    this.phase = 'starting';
    this.emitPhase('starting', '读取凭据');

    const onebot = this.oneBotConfigFor(uin);
    const botConfig: Omit<BotConfig, 'account'> = { ...this.options.config };
    if (onebot) botConfig.onebot = onebot;
    else delete botConfig.onebot;

    // `qq.installDir` / `qq.dataDir` 只是给控制台探测用的提示，bot 不消费；
    // `dbPath` 才是它真正读的字段 —— 显式配置优先，否则按账号目录推导。
    const { installDir: _installDir, dataDir: _dataDir, ...qqRest } = this.options.config.qq ?? {};
    void _installDir;
    void _dataDir;
    const derivedDbPath =
      qqRest.dbPath ??
      findNtMsgDb({
        platform: paths.platform,
        dataRoot: paths.dataRoot,
        uin,
        ...(stored.uid ? { uid: stored.uid } : {}),
      }) ??
      undefined;
    if (derivedDbPath || Object.keys(qqRest).length > 0) {
      botConfig.qq = { ...qqRest, ...(derivedDbPath ? { dbPath: derivedDbPath } : {}) };
    } else {
      delete botConfig.qq;
    }

    const bot = this.botFactory({
      config: { ...botConfig, account: { uin } },
      native: this.options.native,
      vault: this.options.vault,
      logger: this.log.child('bot'),
      onActionCall: (entry) => this.observability.recordAction(entry),
    });
    this.bot = bot;
    this.startedAccount = uin;
    this.wireBot(bot);

    try {
      await bot.start();
      this.phase = 'online';
      this.emitPhase('online', '已上线');
      this.log.info('账号已上线', { uin });
    } catch (cause) {
      this.phase = 'offline';
      this.emitPhase('offline', messageOf(cause));
      this.log.error('账号上线失败', { uin, cause: messageOf(cause) });
      // 策略拒绝是**预期内**的结果，不是服务端故障：必须作为 4xx + 稳定 code
      // 给到前端，否则 `guard()` 会统一吞成 500 INTERNAL，页面只能显示一句
      // 「内部错误」—— 用户会以为是凭据坏了，去反复重新扫码。
      if (isWeqBotError(cause) && cause.code === 'ACCESS_DENIED') {
        throw new HttpError(403, 'ACCESS_DENIED', cause.message);
      }
      throw cause;
    }
  }

  /**
   * 用当前 QQ 安装刷新 vault 里的设备档案。
   *
   * vault 存的是**上次登录时**的档案。QQ 升级后 `subAppId` / `clientVersion`
   * 会变，继续用旧值会让 ECDH 被静默丢弃或 EasyLogin 报参数错误。
   * 只刷新设备字段，凭据（a1 / guid / uid）原样保留。
   */
  private async refreshDevice(
    stored: StoredAccount,
    environment: LoginEnvironment,
  ): Promise<StoredAccount> {
    if (!environment.client) return stored; // 没有 major.node 就保持原样，交给上层报错
    const device = deviceProfileOf(environment);
    const changed =
      device.appId !== stored.device.appId ||
      device.subAppId !== stored.device.subAppId ||
      device.clientVersion !== stored.device.clientVersion ||
      device.qua !== stored.device.qua;
    if (!changed) return stored;
    const next: StoredAccount = { ...stored, device };
    try {
      await this.options.vault.put(next);
      this.log.info('设备档案已随 QQ 版本更新', {
        uin: stored.uin,
        from: stored.device,
        to: device,
      });
    } catch (cause) {
      // 写回失败不阻塞登录：本次用新档案照样能上，只是下次还要再算一遍。
      this.log.warn('设备档案写回 vault 失败（已忽略）', {
        uin: stored.uin,
        cause: messageOf(cause),
      });
    }
    return next;
  }

  private async accountFromLoginDb(
    uin: string,
    paths: QqPaths,
    environment: LoginEnvironment,
  ): Promise<StoredAccount> {
    // `readLoginDbAccounts` 依赖 `probeCache` 里的 HMAC 算法（它自己是同步的，
    // 拿不到 async 的探测结果）。用户可能没先打开登录页就调 startAccount，
    // 所以这里必须自己预热一次，否则永远读不到 a1 并报 NO_CREDENTIAL。
    await this.refreshLoginAccounts();
    const rows = this.readLoginDbAccounts();
    const row = rows.find((item) => item.uin === uin);
    if (!row?.a1Payload) {
      throw new HttpError(
        400,
        'NO_CREDENTIAL',
        '本机 login.db 里没有这个账号的可用 a1，请用扫码登录',
      );
    }
    if (!environment.client) {
      throw new HttpError(
        400,
        'NO_CLIENT_META',
        '找不到可解析的 major.node，无法确定客户端身份；可用扫码登录',
      );
    }
    const guid = row.guid ?? this.readGuid(paths.dataRoot);
    if (!guid) throw new HttpError(400, 'NO_GUID', '读不到设备 guid，无法用本机凭据登录');

    const device = deviceProfileOf(environment);
    const stored: StoredAccount = {
      uin: row.uin,
      uid: row.uid,
      // a1Payload 是 hex 串；vault 存的是原始字节。
      a1: new Uint8Array(Buffer.from(row.a1Payload, 'hex')),
      guid,
      device,
      a1Origin: 'login-db',
    };
    try {
      await this.options.vault.put(stored);
    } catch (cause) {
      throw new HttpError(500, 'VAULT_WRITE_FAILED', `写凭据失败：${messageOf(cause)}`);
    }
    return stored;
  }

  /**
   * 扫码登录。**同一时刻只有一次**：重复请求复用正在跑的那一次。
   *
   * 返回的是当前快照；进度通过 `consoleEvents` 的 `qr` 事件推给页面。
   * 45 秒硬超时 —— 到点把状态置为 `expired`，页面显示「刷新」。
   */
  async startQrLogin(): Promise<QrSnapshot> {
    if (this.phase === 'online' || this.phase === 'starting') {
      throw new HttpError(409, 'ALREADY_ONLINE', '已有账号在线，先退出登录再切换');
    }
    if (this.qr) return this.qr.snapshot;

    const binding = this.options.binding;
    if (!binding.qrLogin) {
      throw new HttpError(501, 'QR_UNSUPPORTED', '该原生组件不支持扫码登录');
    }
    const environment = await this.environment();
    if (!environment.client) {
      throw new HttpError(400, 'NO_CLIENT_META', '找不到可解析的 major.node，无法开始扫码');
    }
    const paths = await this.paths();
    const guid = this.readGuid(paths.dataRoot);
    if (!guid) throw new HttpError(400, 'NO_GUID', '读不到设备 guid，无法开始扫码');

    const snapshot: QrSnapshot = { state: 'waiting-scan', expiresAt: Date.now() + QR_TIMEOUT_MS };
    const promise = this.runQrLogin(snapshot, binding, environment, guid);
    this.qr = { snapshot, promise };
    return snapshot;
  }

  private async runQrLogin(
    snapshot: QrSnapshot,
    binding: RawNativeBinding,
    environment: LoginEnvironment,
    guid: string,
  ): Promise<QrSnapshot> {
    const client = environment.client!;
    const device = deviceProfileOf(environment);
    const update = (patch: Partial<QrSnapshot>): void => {
      Object.assign(snapshot, patch);
      this.emitQr(snapshot);
    };

    this.emitQr(snapshot);
    const timer = setTimeout(() => {
      if (snapshot.state === 'waiting-scan' || snapshot.state === 'waiting-confirm') {
        update({ state: 'expired', error: '二维码已过期' });
      }
    }, QR_TIMEOUT_MS);
    timer.unref?.();

    try {
      const result: QuickLoginResult = await binding.qrLogin!(
        {
          uin: '',
          a1: Buffer.alloc(0),
          guid,
          // napi 的 `Option<String>` 只认 `undefined`，传 `null` 会报
          // 「Failed to convert Null into rust type String」。
          uid: undefined,
          // 两个 AppId 语义不同，见 `deviceProfileOf` 的注释。
          appId: device.appId,
          subAppId: device.subAppId,
          // 同样是 napi `Option<String>`：缺值传 `undefined`，不要传 `null`。
          wrapperPath: environment.wrapperNode ?? undefined,
          os: OS_NAME[osOf(process.platform)],
          platform: NATIVE_PLATFORM[osOf(process.platform)],
          qua: client.qua ?? undefined,
          clientVersion: client.version ?? undefined,
        },
        (error, event) => {
          if (error) {
            update({ state: 'invalid', error: error.message });
            return;
          }
          const record = event as Record<string, unknown> | null;
          if (!record) return;
          const kind = typeof record.kind === 'string' ? record.kind : '';
          if (kind === 'qr-code') {
            const image = record.qrImage;
            update({
              ...(typeof record.qrUrl === 'string' ? { url: record.qrUrl } : {}),
              ...(Buffer.isBuffer(image) ? { image: image.toString('base64') } : {}),
              state: 'waiting-scan',
            });
          } else if (kind === 'qr-state') {
            const state = typeof record.state === 'string' ? record.state : snapshot.state;
            update({
              state,
              ...(typeof record.uin === 'string' && record.uin ? { uin: record.uin } : {}),
            });
          }
        },
      );

      if (!result.uin) throw new Error('扫码完成但没有返回 uin');
      update({ state: 'confirmed', uin: result.uin });
      await this.persistQrAccount(result, environment, guid);
      // 扫码成功后直接上线；失败由调用方从 `startAccount` 的错误里看到。
      await this.startAccount(result.uin);
      return snapshot;
    } catch (cause) {
      const message = messageOf(cause);
      // 超时已经置成 expired 了，不要再覆盖成 invalid。
      if (snapshot.state !== 'expired') {
        // 策略拒绝：扫码已经成功、只是上线被拦。用专门的文案，别让用户以为
        // 是二维码或凭据出了问题（那样会反复重扫）。
        update({
          state: 'invalid',
          error:
            isWeqBotError(cause) && cause.code === 'ACCESS_DENIED'
              ? '当前构建的项目策略限制了登录 —— 与扫码或 QQ 凭据无关。'
              : message,
        });
      }
      this.log.warn('扫码登录失败', { cause: message });
      return snapshot;
    } finally {
      clearTimeout(timer);
      this.qr = undefined;
    }
  }

  private async persistQrAccount(
    result: QuickLoginResult,
    environment: LoginEnvironment,
    guid: string,
  ): Promise<void> {
    const existing = await this.options.vault.get(result.uin);
    const device = deviceProfileOf(environment);
    await this.options.vault.put({
      uin: result.uin,
      uid: result.uid ?? existing?.uid ?? '',
      // 登录过程中服务端可能下发新 a1；没有就沿用旧值（没有则明确报错）。
      a1:
        result.a1 && result.a1.length > 0
          ? new Uint8Array(result.a1)
          : (existing?.a1 ?? new Uint8Array()),
      guid: existing?.guid ?? guid,
      device: existing?.device ?? device,
      a1Origin: 'qr',
    } as StoredAccount);
  }

  /** 取消正在进行的扫码（页面点「刷新」或关页时）。 */
  cancelQrLogin(): void {
    this.qr = undefined;
  }

  // ─────────────────────────── 总览 ───────────────────────────

  overview(): ConsoleOverview {
    const bot = this.bot;
    const snapshot: BotSnapshot | undefined = bot?.snapshot;
    const identity = this.identityFor(bot);
    const sortedHeartbeats = [...this.heartbeats].sort((a, b) => a - b);
    const median =
      sortedHeartbeats.length === 0
        ? undefined
        : sortedHeartbeats[Math.floor(sortedHeartbeats.length / 2)];
    return {
      phase: this.phase,
      ...(snapshot && this.startedAccount
        ? {
            account: {
              uin: snapshot.uin,
              uid: snapshot.uid ?? '',
              nickname: identity.nickname,
              avatarUrl: avatarUrlOf(snapshot.uin),
              ...(snapshot.onlineSince !== undefined ? { onlineSince: snapshot.onlineSince } : {}),
              startedAt: snapshot.startedAt,
              ...(snapshot.device ? { device: snapshot.device } : {}),
              reconnects: snapshot.reconnects,
              ...(snapshot.secTokenRotatesAt !== undefined
                ? { secTokenRotatesAt: snapshot.secTokenRotatesAt }
                : {}),
              ...(snapshot.sessionId !== undefined ? { sessionId: snapshot.sessionId } : {}),
            },
          }
        : {}),
      messages: { received: this.received, sent: this.sent },
      heartbeat: {
        samples: this.heartbeats.slice(-40),
        ...(median !== undefined ? { medianMs: median } : {}),
      },
      networks: bot?.onebot?.networks() ?? [],
      actions: {
        registered: bot?.onebot?.actions().length ?? 0,
        skipped: bot?.onebot?.skipped().length ?? 0,
      },
      ...(bot?.onebot?.port !== undefined ? { onebotPort: bot.onebot.port } : {}),
      system: systemSnapshot(),
    };
  }

  /** 昵称从 vault / login.db 拿；后端 `getLoginInfo` 也有一份但那是 OneBot 面的事。 */
  private identityFor(_bot: Bot | undefined): { nickname: string } {
    return { nickname: this.cachedNickname ?? '' };
  }

  private cachedNickname: string | undefined;
  /** uin → login.db 里带签名的头像 URL（只给头像代理用，不进任何响应）。 */
  private readonly avatarSources = new Map<string, string>();

  /** 头像上游 URL：优先 login.db 给的签名 URL，退化成公开接口。 */
  avatarSource(uin: string): string {
    return (
      this.avatarSources.get(uin) ??
      `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(uin)}&s=100`
    );
  }

  /** 账号主卡的头像也走同源代理，这里保持与 `/api/avatar/:uin` 一致。 */
  avatarUrlFor(uin: string): string {
    return avatarUrlOf(uin);
  }

  async loadIdentity(): Promise<void> {
    const uin = this.startedAccount;
    if (!uin) return;
    const rows = this.readLoginDbAccounts();
    const row = rows.find((item) => item.uin === uin);
    if (row?.userName) this.cachedNickname = row.userName;
  }

  // ─────────────────────────── 下线 ───────────────────────────

  /**
   * 账号下线（`POST /api/account/logout`）。
   *
   * `forgetCredential` 为真时同时删 vault —— 那是「这台机器不再记得这个账号」，
   * 与「退出登录」是两件事，前端把两个动作分开。
   */
  async logout(options: { forgetCredential?: boolean } = {}): Promise<void> {
    const bot = this.bot;
    const uin = this.startedAccount;
    this.bot = undefined;
    this.startedAccount = undefined;
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];
    this.received = 0;
    this.sent = 0;
    this.heartbeats.length = 0;
    this.cachedNickname = undefined;
    if (bot) {
      try {
        await bot.stop('closed');
      } catch (cause) {
        this.log.warn('账号下线时出错（已忽略）', { cause: messageOf(cause) });
      }
    }
    if (options.forgetCredential && uin) {
      try {
        await this.options.vault.delete(uin);
        this.log.info('凭据已删除', { uin });
      } catch (cause) {
        this.log.warn('删除凭据失败', { uin, cause: messageOf(cause) });
      }
    }
    this.phase = 'no-account';
    this.emitPhase('no-account', '已退出登录');
  }

  /** 进程退出前清理。 */
  async close(): Promise<void> {
    await this.logout();
  }

  // ─────────────────────────── 内部 ───────────────────────────

  private wireBot(bot: Bot): void {
    this.unsubscribers.push(
      bot.events.on('state', (change) => {
        this.observability.recordEvent(change);
        if (change.to === 'online') {
          this.phase = 'online';
          void this.loadIdentity();
        } else if (change.to === 'closed' && this.phase !== 'no-account') {
          this.phase = 'offline';
        }
      }),
      bot.events.on('heartbeat', (event) => {
        if (typeof event.rttMs === 'number' && Number.isFinite(event.rttMs)) {
          this.heartbeats.push(event.rttMs);
          if (this.heartbeats.length > 240) this.heartbeats.shift();
        }
      }),
      bot.events.on('message', (message) => {
        if (message.scene === 'private' || message.scene === 'group') this.received += 1;
        this.observability.recordEvent({ type: 'message', message });
      }),
      bot.events.on('notice', (notice) => this.observability.recordEvent(notice)),
      bot.events.on('request', (request) => this.observability.recordEvent(request)),
      bot.events.on('event', (event) => {
        if (event.type === 'error') {
          this.log.error(event.error.message, { code: event.error.code });
        }
      }),
    );
  }

  private emitPhase(phase: ConsolePhase, detail?: string): void {
    const event: ConsoleStateEvent = {
      phase,
      at: Date.now(),
      ...(detail ? { detail } : {}),
    };
    this.events.emit('console', event as never);
  }

  private emitQr(snapshot: QrSnapshot): void {
    this.events.emit('console', { qr: snapshot } as never);
  }

  /**
   * 取路径探测结果（TTL 缓存 + 单飞）。
   *
   * `refresh` 为 true 时不等 TTL，立刻作废并重算 —— 「重新检查」按钮走这条路。
   */
  private async paths(refresh = false): Promise<QqPaths> {
    const ttl = this.options.qqPathsTtlMs ?? QQ_PATHS_TTL_MS;
    if (!refresh && this.qqPathsCache && Date.now() - this.qqPathsCache.at < ttl) {
      return this.qqPathsCache.value;
    }
    if (refresh) {
      this.invalidateQqPaths();
    } else if (this.qqPathsPending) {
      return this.qqPathsPending;
    }

    const pending = this.probePaths().finally(() => {
      if (this.qqPathsPending === pending) this.qqPathsPending = undefined;
    });
    this.qqPathsPending = pending;
    return pending;
  }

  private async probePaths(): Promise<QqPaths> {
    const discover = this.options.discoverPaths;
    let paths: QqPaths;
    if (discover) {
      paths = await discover();
    } else {
      const hints = await ensureQqHints();
      paths = discoverQqPaths({
        ...(this.options.qqPathsOverride ? { overrides: this.options.qqPathsOverride } : {}),
        hints,
      });
    }
    this.qqPathsCache = { value: paths, at: Date.now() };
    this.loginPathsCache = paths.loginDbs;
    return paths;
  }

  /**
   * 作废路径与前缀缓存。
   *
   * 三样必须一起清，否则会出现「路径新、账号还是旧的」这种半新半旧状态：
   * 路径缓存、`login.db` 路径镜像、`login.db` 行缓存与探测缓存。
   */
  invalidateQqPaths(): void {
    this.qqPathsCache = undefined;
    this.qqPathsPending = undefined;
    this.loginPathsCache = undefined;
    this.loginRowsCache = undefined;
    this.probeCache.clear();
    // 注册表 / Spotlight 的探测结果同样可能随 QQ 重装而变。
    clearQqHintsCache();
  }

  /**
   * 设置页保存后调用：写入手动覆盖并立即失效。
   *
   * 直接改 `options.qqPathsOverride`（与「网络页改 `options.config`」同一模式），
   * 下次 `paths()` 就用新值。
   */
  setQqPathOverrides(next: QqPathOverrides | null): void {
    this.options.qqPathsOverride = next;
    this.invalidateQqPaths();
  }

  /** 当前生效的手动覆盖（设置页预填输入框用）。 */
  get qqPathOverrides(): QqPathOverrides | null {
    return this.options.qqPathsOverride ?? null;
  }

  /**
   * 当前账号要用的 `nt_msg.db`：显式配置优先，否则按账号目录推导。
   *
   * 推导依赖账号上下文（win32 要 uin、unix 要 uid），所以只在已经绑定账号时有用。
   */
  private async ntMsgDbForBoundAccount(paths: QqPaths): Promise<string | null> {
    if (this.options.qqDbPath) return this.options.qqDbPath;
    const uin = this.startedAccount;
    if (!uin) return null;
    const uid = await this.uidOfAccount(uin);
    return findNtMsgDb({
      platform: paths.platform,
      dataRoot: paths.dataRoot,
      uin,
      ...(uid ? { uid } : {}),
    });
  }

  /**
   * 找这个 uin 的 uid：vault 优先（凭据里一定有），其次 `login.db` 的解码结果。
   *
   * 设置页可能在没进过登录页时直接打开，此时 `loginRowsCache` 还是空的；这里补一次
   * 预热，让 `nt_msg.db` 的推导不依赖用户的操作顺序。
   */
  private async uidOfAccount(uin: string): Promise<string | undefined> {
    const cached = this.loginRowsCache?.rows.find((item) => item.uin === uin);
    if (cached) return cached.uid;

    const stored = await this.options.vault.get(uin);
    if (stored?.uid) return stored.uid;

    try {
      const rows = await this.refreshLoginAccounts();
      return rows.find((item) => item.uin === uin)?.uid;
    } catch (cause) {
      this.log.warn('推导 nt_msg.db 时读 login.db 失败', { cause: messageOf(cause) });
      return undefined;
    }
  }

  /** 解 `login.db`；任何一步失败都返回空表（登录页应当能看到「没有账号」而不是 500）。 */
  private readLoginDbAccounts(): LoginRow[] {
    const cached = this.loginRowsCache;
    if (cached && Date.now() - cached.at < 30_000) return cached.rows;
    const binding = this.options.binding;
    if (!binding.testDatabaseKey || !binding.decryptLoginDb) return [];
    const rows: LoginRow[] = [];
    for (const dbPath of this.loginPathsCache ?? []) {
      try {
        const probe = binding.testDatabaseKey(dbPath, LOGIN_DB_KEY);
        // native 的 `testDatabaseKey` 是 async，这里必须同步拿算法 —— 用缓存的
        // 探测结果（成功时不会变），首次由 `refreshLoginAccounts()` 预热。
        const resolved = isPromise(probe) ? undefined : probe;
        const algo = resolved ?? this.probeCache.get(dbPath);
        if (!(algo?.success && algo.pageHmacAlgorithm && algo.kdfHmacAlgorithm)) continue;
        rows.push(
          ...binding.decryptLoginDb(dbPath, {
            pageHmacAlgorithm: algo.pageHmacAlgorithm,
            kdfHmacAlgorithm: algo.kdfHmacAlgorithm,
          }),
        );
      } catch (cause) {
        this.log.warn('login.db 解密失败', { dbPath, cause: messageOf(cause) });
      }
    }
    const deduped = dedupeByUin(rows);
    this.loginRowsCache = { rows: deduped, at: Date.now() };
    return deduped;
  }

  /** 探测缓存：`login.db` 的 HMAC 算法在同一台机器上不会变。 */
  private readonly probeCache = new Map<
    string,
    { success: boolean; pageHmacAlgorithm?: string | null; kdfHmacAlgorithm?: string | null }
  >();

  /**
   * 预热 `login.db` 探测（异步版本）并刷新账号缓存。
   *
   * 登录页每次进来都会调一次；探测结果缓存，解密在 `readLoginDbAccounts` 里同步做。
   */
  async refreshLoginAccounts(): Promise<LoginRow[]> {
    const binding = this.options.binding;
    // 无论如何先拿到路径：即使没有解密能力，`accounts()` 也要用 `loginDbs` 之外的信息。
    const paths = await this.paths();
    if (!binding.testDatabaseKey || !binding.decryptLoginDb) {
      this.loginPathsCache = paths.loginDbs;
      return [];
    }
    for (const dbPath of paths.loginDbs) {
      if (this.probeCache.has(dbPath)) continue;
      try {
        this.probeCache.set(dbPath, await binding.testDatabaseKey(dbPath, LOGIN_DB_KEY));
      } catch (cause) {
        this.log.warn('login.db 探测失败', { dbPath, cause: messageOf(cause) });
      }
    }
    const rows = this.readLoginDbAccounts();
    this.loginRowsCache = { rows, at: Date.now() };
    return rows;
  }

  private readGuid(dataRoot: string | null): string | null {
    if (!dataRoot || !this.options.binding.readDeviceGuid) return null;
    try {
      return this.options.binding.readDeviceGuid(dataRoot);
    } catch (cause) {
      this.log.warn('readDeviceGuid 失败', { cause: messageOf(cause) });
      return null;
    }
  }
}

interface LoginRow {
  uin: string;
  uid: string;
  avatarUrl?: string;
  userName?: string;
  lastLoginAt?: number;
  a1Payload?: string | null;
  guid?: string | null;
}

function dedupeByUin(rows: LoginRow[]): LoginRow[] {
  const merged = new Map<string, LoginRow>();
  for (const row of rows) {
    if (!row.uin) continue;
    if (!merged.has(row.uin)) merged.set(row.uin, row);
  }
  return [...merged.values()];
}

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T>)?.then === 'function';
}

const OS_NAME: Record<DeviceProfile['os'], string> = {
  linux: 'Linux',
  darwin: 'Mac',
  win32: 'Windows',
};
const NATIVE_PLATFORM: Record<DeviceProfile['os'], number> = { linux: 7, darwin: 5, win32: 4 };

/**
 * EasyLogin `AppInfo.AppId`（**不是** SSO subAppId）。
 *
 * 两个 AppId 在协议里是不同字段，历史上这里混用过，务必分清：
 *
 * - 本表是 Lagrange `BotAppInfo` 的 `AppId`，协议固定的产品身份（Linux 是
 *   `1600001615`），与 QQ 版本无关；
 * - SSO 头的 `subAppId` 才随 QQ 构建变，取 `major.node` 的 appid
 *   （本机 3.2.35-54395 是 `537403759`）。
 *
 * 写错的后果：ECDH 被服务端静默丢弃（20s 读超时），或 EasyLogin 回
 * `140022001 参数错误`。
 */
const EASY_LOGIN_APP_ID: Record<DeviceProfile['os'], number> = {
  linux: 1600001615,
  darwin: 1600001602,
  win32: 1600001604,
};

function osOf(platform: NodeJS.Platform): DeviceProfile['os'] {
  if (platform === 'darwin') return 'darwin';
  if (platform === 'win32') return 'win32';
  return 'linux';
}

/**
 * SSO 头的 `subAppId`，取自 `major.node` 的 `QQAppId`。
 *
 * **必须等于当前 QQ 构建的 appid**（本机 3.2.35-54395 是 `537403759`）。
 * 写死成别的值（历史上这里错写成 `5371`）会让服务端**静默丢弃** ECDH 请求：
 * TCP 建连成功、只回 ACK、零应用层字节，20s 后表现为「读登录应答超时」，
 * 看起来像网络问题或凭据问题，实际是应用身份不对。
 */
function subAppIdOf(environment: LoginEnvironment): number {
  const appid = environment.client?.appid;
  if (!appid) {
    throw new HttpError(400, 'NO_CLIENT_META', '找不到可解析的 major.node，无法确定 SSO subAppId');
  }
  return Number(appid);
}

/**
 * 从本机 QQ 安装构造设备档案。
 *
 * 三个字段各有来源，**不能互相顶替**：
 *
 * - `appId`：EasyLogin `AppInfo.AppId`，协议固定（见 `EASY_LOGIN_APP_ID`）；
 * - `subAppId`：SSO 头字段，取 `major.node` 的 appid；
 * - `clientVersion` / `qua`：取 `major.node`，版本号要带 build
 *   （`3.2.35-54395`，不是 `3.2.35`），否则 EasyLogin 回 `140022001`。
 */
function deviceProfileOf(environment: LoginEnvironment): DeviceProfile {
  const os = osOf(process.platform);
  const client = environment.client;
  if (!client) {
    throw new HttpError(
      400,
      'NO_CLIENT_META',
      '找不到可解析的 major.node，无法确定客户端身份；可用扫码登录',
    );
  }
  return {
    os,
    appId: EASY_LOGIN_APP_ID[os],
    subAppId: subAppIdOf(environment),
    qua: client.qua ?? `V1_${environment.platform.toUpperCase()}_9.9.9`,
    // build 必须拼上：只写 `3.2.35` 会被 EasyLogin 判成参数错误。
    clientVersion: client.version && client.build ? `${client.version}-${client.build}` : '9.9.9',
  };
}

/** 设备状态采样。全部是同步的轻量系统调用，跟着总览轮询走。 */
function systemSnapshot(): ConsoleSystem {
  const usage = process.memoryUsage();
  const logDir = getLogDirectory();
  const storagePath = logDir ?? process.cwd();
  let storage: ConsoleSystem['storage'];
  try {
    const fs = statfsSync(storagePath);
    storage = {
      path: storagePath,
      total: fs.blocks * fs.bsize,
      free: fs.bavail * fs.bsize,
    };
  } catch {
    // 路径不存在 / 文件系统不支持：盘容量这一项省略，其它指标照常。
  }
  return {
    platform: process.platform,
    arch: arch(),
    cpus: cpus().length,
    loadAvg: loadavg(),
    uptimeSec: Math.round(uptime()),
    processUptimeSec: Math.round(process.uptime()),
    memory: { rss: usage.rss, heapUsed: usage.heapUsed, heapTotal: usage.heapTotal },
    systemMemory: { total: totalmem(), free: freemem() },
    ...(storage ? { storage } : {}),
    logDir,
  };
}

function avatarUrlOf(uin: string): string {
  // 走同源代理；页面的 CSP 不放行外网图片域名。
  return `/api/avatar/${encodeURIComponent(uin)}`;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
