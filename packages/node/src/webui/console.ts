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

import { randomBytes } from 'node:crypto';
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
import {
  groupScopedVault,
  type AccountGroup,
  type BotEventMap,
  type CredentialVault,
  type StoredAccount,
} from '@weqbot/session';
import type {
  DeviceProfile,
  LoginProgressEvent,
  NativePort,
  QuickLoginResult,
  RawNativeBinding,
} from '@weqbot/wire';
import {
  AttachError,
  describeElevation,
  listQqInstances,
  looksLikeQqProcess,
  scanSessionMaterial,
  type ElevationState,
} from './attach';
import { HttpError } from './http-util';
import type { Observability } from './observability';
import { findNtMsgDb } from './qq-account';
import { clearQqHintsCache, ensureQqHints } from './qq-detect';
import {
  discoverQqPaths,
  LOGIN_DB_KEY,
  type QqPathOverrides,
  type QqPaths,
  verifyFileOptionsFor,
} from './qq-paths';

export type ConsolePhase = 'no-account' | 'starting' | 'online' | 'offline';

/** 可以直接上线的本机账号（没有 a1 的不在列表里，见 `accounts()`）。 */
export interface ConsoleAccount {
  uin: string;
  uid: string;
  /**
   * 凭据来源。同一条 uin 可能同时出现在两个来源里，语义不同，页面必须分开列：
   * vault 是我们自己存的，`login-db` 是 QQ 本体最后写入的。
   */
  source: AccountSource;
  /**
   * 账号分组。本机组 = 复用本机 uid / guid；自主组 = 自持 guid。
   *
   * 页面按 `group` 分 tab，`source` 只用来解释「这条凭据是哪来的」；两者不能
   * 互相推导（本机组的兜底条目也来自 vault）。
   */
  group: AccountGroup;
  nickname?: string;
  avatarUrl?: string;
  lastLoginAt?: number;
  /**
   * 这个账号**在 QQ 本体里**是否在线（QQ 进程持有它的 `nt_msg.db`）。
   *
   * 登录页据此展示徽标并要求用户知情：登录 WeqBot 会先结束那个 QQ 进程
   * （否则同一账号双端在线，消息会出现两处）。探测不到时省略。
   */
  qqOnline?: boolean;
  /**
   * 正持有这个账号 `nt_msg.db` 的 QQ 进程。
   *
   * 有头模式用它拿「接哪个进程」；没有 `probeDbLock` 能力时省略。
   */
  qqPid?: number;
}

/** 一个正在运行的 QQ 进程（登录页「有头模式」的列表项）。 */
export interface ConsoleInstance {
  pid: number;
  /** 认出账号身份时才有；否则只能看到 pid。 */
  uin?: string;
  uid?: string;
  nickname?: string;
  avatarUrl?: string;
  /** 运行中 QQ 的版本（来自它的 `major.node`）。 */
  qqVersion?: string;
  /** 能直接接入（账号身份已知 + 原生能力齐）。 */
  attachable: boolean;
  /** 不能接入时的一句话原因。 */
  note?: string;
}

/** `GET /api/login/instances` 的返回。 */
export interface AttachSnapshot {
  elevation: ElevationState;
  /** 按 pid 升序；空数组 = 本机没有运行中的 QQ。 */
  instances: ConsoleInstance[];
}

/** `attachAccount` 的选项。 */
export interface AttachOptions {
  /** 目标进程；不传时按账号的库锁反查。 */
  pid?: number;
  /** 刚在提权框里输入的 `sudo` 密码；只在 `ELEVATION_REQUIRED` 后给一次。 */
  password?: string;
}

/** 账号来源：我们自己的凭据库，或本机 `login.db`。 */
export type AccountSource = 'vault' | 'login-db';

/**
 * `startAccount` 的选项：页面指定用哪一**组**账号。
 *
 * 分组不是展示层的标签，而是凭据与设备身份的边界：
 *
 * - `local`：本机账号。a1 每次从 `login.db` 现解，uid / guid 复用本机的；
 * - `self`：自主账号。凭据来自 vault，guid 是首次扫码时生成并持久化的那个。
 *
 * 省略时按「有自主凭据就自主，否则本机」推断，保留旧调用方的行为。
 */
export interface StartAccountOptions {
  group?: AccountGroup;
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
  /** 需要页面主动反应的事件（目前只有「a1 失效，请改扫码」）。 */
  notice?: ConsoleNotice;
  /**
   * 登录进度：上线期间（`phase === 'starting'`）的实时说明。
   *
   * 主要是异常设备确认 —— 那时 native 会安静地等手机确认最长 45 秒，页面
   * 没有这条事件就只剩一个转圈。
   */
  progress?: LoginProgressEvent;
}

/**
 * 页面需要跳转 / 弹提示的一次性信号。
 *
 * 单靠 `phase` 表达不了「为什么回登录页」：`no-account` 既可能是用户主动退出，
 * 也可能是凭据没了。带上 `kind` 页面才能决定要不要把人引到扫码 tab。
 */
export interface ConsoleNotice {
  kind: 'a1-expired';
  uin: string;
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

/** 登录前结束 QQ 本体后，等它释放 `nt_msg.db` 锁的最长时间。 */
const QQ_KILL_WAIT_MS = 3000;

/** 等锁释放时的轮询间隔。 */
const QQ_KILL_POLL_MS = 150;

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
  /** 在线账号属于哪一组；失效清理 / 忘记凭据只动这一组。 */
  private startedGroup: AccountGroup | undefined;
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
   * 账号列表：按**分组**列出能上线的账号。
   *
   * - 本机组（`local`）：`login.db` 解出来的行，外加 vault 里的本机镜像（仅当
   *   同一个 uin 在 `login.db` 里读不到时——否则它会和 login.db 那条重复）；
   * - 自主组（`self`）：只有 vault，guid 自持。
   *
   * 两组**不合并**，每条带 `group` 与 `source`：分组决定用哪份设备身份，来源解释
   * 这条凭据是哪来的。a1 失效时的清理也只看组：本机组不动 `login.db`（QQ 侧可能
   * 已经刷新过 a1，我们不知道），自主组删 vault 那一条。
   *
   * **两个来源都只列出能直接上线的账号** —— 没有 a1 的行不出现。列表是「点一下就能
   * 登录」的入口，而 `startAccount` 拿不到 a1 时必然报 `NO_CREDENTIAL`；把这些行一起
   * 列出来只会让用户点进去再被打回来。
   *
   * **不返回 a1**（`login.db` 的 `a1Payload` 只在 `startAccount` 的局部变量里活一次）。
   */
  async accounts(): Promise<ConsoleAccount[]> {
    const paths = await this.paths();
    const out: ConsoleAccount[] = [];
    // vault 里的凭据一定有 a1（`get()` 读不出 a1 会直接抛 CREDENTIAL_CORRUPT）。
    // 自主组也走这里 —— 它只有 vault 一个来源。
    for (const account of await this.options.vault.list()) {
      out.push({
        uin: account.uin,
        uid: account.uid,
        source: 'vault',
        group: account.group,
        avatarUrl: avatarUrlOf(account.uin),
        ...(account.lastOnlineAt ? { lastLoginAt: account.lastOnlineAt } : {}),
      });
    }

    await this.refreshLoginAccounts();
    const localFromLoginDb = new Set<string>();
    for (const row of this.readLoginDbAccounts()) {
      if (!row.a1Payload) continue;
      localFromLoginDb.add(row.uin);
      out.push({
        uin: row.uin,
        uid: row.uid,
        source: 'login-db',
        group: 'local',
        ...(row.userName ? { nickname: row.userName } : {}),
        // 头像统一走同源代理：页面的 CSP 不放行外网图片域名，而 login.db 里的
        // `avatarUrl`（thirdqq.qlogo.cn 带 k/kti 签名）需要服务端原样转发才有。
        avatarUrl: avatarUrlOf(row.uin),
        ...(row.lastLoginAt ? { lastLoginAt: row.lastLoginAt * 1000 } : {}),
      });
      // 代理用的上游 URL 留在服务端，不发给页面。
      if (row.avatarUrl) this.avatarSources.set(row.uin, row.avatarUrl);
    }

    // 本机组以 `login.db` 为准：vault 里的本机镜像只是「库读不出来时的兜底」，
    // 两边都列一次只会让同一账号在一屏里出现两遍（而且两份 a1 指向同一设备）。
    const rows = out.filter(
      (item) =>
        !(item.group === 'local' && item.source === 'vault' && localFromLoginDb.has(item.uin)),
    );

    // 「QQ 本体在线」按 uin 探测一次（同一 uin 可能在两个组里各有一条）。
    // 探测不到（推不出 dbPath / native 缺能力）时不给这个字段 —— 页面据此
    // 区分「已知不在线」与「不知道」，不用 `false` 冒充结论。
    const stateByUin = new Map<string, QqAccountState>();
    for (const item of rows) {
      if (stateByUin.has(item.uin)) continue;
      stateByUin.set(item.uin, await this.qqStateOf(item.uin, item.uid, paths));
    }

    return rows
      .map((item) => {
        const state = stateByUin.get(item.uin) ?? {};
        return {
          ...item,
          ...(state.online !== undefined ? { qqOnline: state.online } : {}),
          // pid 给有头模式用：它要的是「接哪个进程」，而不只是「在不在线」。
          ...(state.pid !== undefined ? { qqPid: state.pid } : {}),
        };
      })
      .sort((a, b) => (b.lastLoginAt ?? 0) - (a.lastLoginAt ?? 0));
  }

  /**
   * 有头模式的入口数据：提权状态 + 正在运行的 QQ 实例。
   *
   * 实例列表**不是**账号列表的子集：它按进程来（一个 QQ 多开就有多条），
   * 账号身份靠「谁持有那个 uin 的 nt_msg.db」串起来。串不上的进程仍然列出来，
   * 但标成不可接入 —— 让用户看到「QQ 在跑但认不出账号」比默默消失好。
   */
  async attachSnapshot(): Promise<AttachSnapshot> {
    const elevation = await describeElevation();
    const accounts = await this.accounts();
    const byPid = new Map<number, ConsoleAccount>();
    for (const account of accounts) {
      if (account.qqPid !== undefined) byPid.set(account.qqPid, account);
    }

    const processes = listQqInstances(this.options.binding);
    // 旧构建没有 `listProcessesWithModule` 时退回「按库锁反查到的 pid」：
    // 探测方式可以降级，接入能力不该因此消失。
    const pids = processes.length > 0 ? processes.map((process) => process.pid) : [...byPid.keys()];

    const instances = pids.map((pid): ConsoleInstance => {
      const account = byPid.get(pid);
      const process = processes.find((item) => item.pid === pid);
      let version: string | undefined;
      if (process?.majorPath && this.options.binding.resolveAppidFromMajor) {
        try {
          const info = this.options.binding.resolveAppidFromMajor(process.majorPath);
          version = info.version
            ? `${info.version}${info.build ? `-${info.build}` : ''}`
            : undefined;
        } catch {
          version = undefined;
        }
      }
      if (!account) {
        return {
          pid,
          attachable: false,
          note: '认不出这个 QQ 进程属于哪个账号（可能刚启动），有头模式需要知道账号身份',
          ...(version ? { qqVersion: version } : {}),
        };
      }
      return {
        pid,
        uin: account.uin,
        uid: account.uid,
        ...(account.nickname ? { nickname: account.nickname } : {}),
        ...(account.avatarUrl ? { avatarUrl: account.avatarUrl } : {}),
        ...(version ? { qqVersion: version } : {}),
        attachable: true,
      };
    });

    return { elevation, instances };
  }

  /**
   * 有头模式上线：借运行中 QQ 的会话（mode 1）。
   *
   * 与 {@link startAccount} 的三个关键差异：
   *
   * 1. **不结束 QQ**：有头模式的前提就是 QQ 在跑；
   * 2. **不读凭据**：a2/d2/d2key 从 QQ 内存里扫，vault 与 `login.db` 都不碰；
   * 3. **可能需要提权**：第一次抛 `ELEVATION_REQUIRED`，页面拿到密码后再调一次。
   *
   * 账号配置仍按 uin 取（`onebotByUin[uin]`）—— 同一个账号无论用哪种方式上线，
   * 网络配置都是同一份。
   */
  async attachAccount(uin: string, options: AttachOptions = {}): Promise<{ pid: number }> {
    if (this.phase === 'online' || this.phase === 'starting') {
      throw new HttpError(409, 'ALREADY_ONLINE', '已有账号在线，先退出登录再切换');
    }
    if (!/^[1-9]\d{4,19}$/.test(uin)) throw new HttpError(400, 'BAD_UIN', 'uin 不合法');

    const paths = await this.paths();
    const environment = await this.environment();
    const account = (await this.accounts()).find((item) => item.uin === uin);
    if (!account) {
      throw new HttpError(404, 'NO_ACCOUNT', '本机没有这个账号的记录，无法有头接入');
    }

    const processes = listQqInstances(this.options.binding);
    const pid = options.pid ?? account.qqPid;
    if (pid === undefined) {
      throw new HttpError(
        409,
        'QQ_OFFLINE',
        '这个账号的本机 QQ 不在运行；有头模式要求 QQ 先登录好，否则请用无头方式或扫码',
      );
    }
    // 显式指定了别的账号的 pid：宁可报错，也不能接错人。
    if (options.pid !== undefined && account.qqPid !== undefined && options.pid !== account.qqPid) {
      throw new HttpError(
        409,
        'WRONG_INSTANCE',
        `pid ${options.pid} 持有的不是 ${uin} 的会话（该账号在 pid ${account.qqPid}）`,
      );
    }

    const device = deviceProfileOf(environment);
    const guid = this.readGuid(paths.dataRoot);
    if (!guid) {
      throw new HttpError(400, 'NO_GUID', '读不到设备 guid，无法有头接入');
    }

    this.phase = 'starting';
    this.emitPhase('starting', `读取 pid ${pid} 的会话`);

    let material: Awaited<ReturnType<typeof scanSessionMaterial>>;
    try {
      material = await scanSessionMaterial({
        binding: this.options.binding,
        logger: this.log,
        pid,
        uin,
        uid: account.uid,
        ...(options.password ? { password: options.password } : {}),
      });
    } catch (cause) {
      this.phase = 'offline';
      this.emitPhase('offline', messageOf(cause));
      throw attachHttpError(cause);
    }

    const onebot = this.oneBotConfigFor(uin);
    const botConfig: Omit<BotConfig, 'account'> = { ...this.options.config };
    if (onebot) botConfig.onebot = onebot;
    else delete botConfig.onebot;
    // `qq.dbPath` 只服务 mode 2 的「QQ 本体不能在线」预检；有头模式不读库。
    delete botConfig.qq;

    const instance = processes.find((item) => item.pid === pid);
    const wrapperPath =
      instance?.wrapperPath ??
      this.options.config.native?.wrapperPath ??
      environment.wrapperNode ??
      undefined;

    const bot = this.botFactory({
      config: { ...botConfig, account: { uin } },
      native: this.options.native,
      vault: this.options.vault,
      logger: this.log.child('bot'),
      onActionCall: (entry) => this.observability.recordAction(entry),
      attach: {
        pid,
        uin,
        uid: account.uid,
        guid,
        a2: material.a2!,
        d2: material.d2!,
        d2Key: material.d2Key!,
        ...(material.secToken ? { secToken: material.secToken } : {}),
        subAppId: device.subAppId,
        clientVersion: device.clientVersion,
        qua: device.qua,
        ...(wrapperPath ? { wrapperPath } : {}),
      },
    });
    this.bot = bot;
    this.startedAccount = uin;
    // 有头模式不落 vault、也不属于任何一组：它借的是本机 QQ 的运行中会话。
    // 设备身份仍然是本机 guid（与 QQ 一致），但这份凭据不该被当成可复用的。
    this.startedGroup = undefined;
    this.wireBot(bot);

    await this.bringUp(bot, uin);
    this.log.info('有头模式已上线', { uin, pid });
    return { pid };
  }

  /**
   * 这个账号在 QQ 本体里的状态：在不在线，以及正持有它是哪个进程。
   *
   * 优先用 `probeDbLock`（能同时拿到 pid：登录前要用它结束进程，有头模式要用
   * 它接会话）；没有这个能力时退回 `isQqLoggedIn` 的布尔结论。两者都没有 /
   * 推不出 dbPath 时返回空对象：页面不应该把「不知道」显示成「不在线」。
   */
  private async qqStateOf(
    uin: string,
    uid: string | undefined,
    paths: QqPaths,
  ): Promise<QqAccountState> {
    const dbPath = this.accountDbPath(uin, uid, paths);
    if (!dbPath) return {};
    const holders = this.qqProcesses(dbPath);
    if (holders && holders.length > 0) return { online: true, pid: holders[0]!.pid };
    // 有探针且一个持有者都没有 = 确定不在线；没有探针才是「不知道」。
    if (holders) return { online: false };
    if (!this.options.native.isQqLoggedIn) return {};
    try {
      return { online: await this.options.native.isQqLoggedIn(dbPath) };
    } catch (cause) {
      this.log.warn('isQqLoggedIn 失败（在线状态未知）', {
        dbPath,
        cause: messageOf(cause),
      });
      return {};
    }
  }

  /**
   * 该账号的 `nt_msg.db`：按账号目录推导优先，其次显式配置的 `qq.dbPath`。
   *
   * 与 `startAccount` 给 bot 的推导顺序一致 —— 页面展示的在线状态必须就是
   * 上线预检会看的那个库，否则会出现「页面说 QQ 在线、登录却报另一回事」。
   */
  private accountDbPath(uin: string, uid: string | undefined, paths: QqPaths): string | null {
    return (
      findNtMsgDb({
        platform: paths.platform,
        dataRoot: paths.dataRoot,
        uin,
        ...(uid ? { uid } : {}),
      }) ??
      this.options.qqDbPath ??
      this.options.config.qq?.dbPath ??
      null
    );
  }

  /**
   * 正持有该库的 QQ 进程。
   *
   * 只认进程名像 QQ 的持有者：三端探针都会把 WeQ / WeqBot 自己报进来，按名字
   * 过滤才不会在登录前把我们自己的进程杀掉。`undefined` 表示没有 `probeDbLock`
   * 能力（调用方退回 `isQqLoggedIn`）。
   */
  private qqProcesses(dbPath: string): Array<{ pid: number }> | undefined {
    const probe = this.options.binding.probeDbLock;
    if (!probe) return undefined;
    try {
      const result = probe(dbPath);
      if (!result.success) return [];
      return result.holders
        .filter((holder) => looksLikeQqProcess(holder.name))
        .map((holder) => ({ pid: holder.pid }))
        .filter((holder) => holder.pid > 0);
    } catch (cause) {
      this.log.warn('probeDbLock 失败（按不在线处理）', { dbPath, cause: messageOf(cause) });
      return [];
    }
  }

  /**
   * 登录前接管账号：结束正持有该 `nt_msg.db` 的 QQ 进程。
   *
   * 页面在用户点账号时已经显示「QQ 本体在线，登录会先结束它」，这里不再二次询问。
   * 只杀**名字像 QQ 且确实持有这个库**的进程，不碰其它进程；杀完等锁释放（最多
   * {@link QQ_KILL_WAIT_MS}），释放不了就交给 `createBot` 的 `isQqLoggedIn` 预检
   * 报 `ALREADY_ONLINE`。
   *
   * 返回结束掉的进程数，供页面提示。
   */
  private async stopQqBody(dbPath: string | null, uin: string): Promise<number> {
    if (!dbPath) return 0;
    const holders = this.qqProcesses(dbPath);
    if (!holders || holders.length === 0) return 0;

    let ended = 0;
    for (const holder of holders) {
      try {
        process.kill(holder.pid);
        ended += 1;
        this.log.info('已结束本机 QQ 进程（登录前接管账号）', { uin, pid: holder.pid });
      } catch (cause) {
        this.log.warn('结束 QQ 进程失败（继续尝试上线）', {
          uin,
          pid: holder.pid,
          cause: messageOf(cause),
        });
      }
    }
    if (ended === 0) return 0;

    const deadline = Date.now() + QQ_KILL_WAIT_MS;
    while (Date.now() < deadline) {
      const remaining = this.qqProcesses(dbPath);
      if (!remaining || remaining.length === 0) return ended;
      await new Promise((resolve) => setTimeout(resolve, QQ_KILL_POLL_MS));
    }
    this.log.warn('QQ 进程已结束但 nt_msg.db 锁仍未释放', {
      uin,
      dbPath,
      waitedMs: QQ_KILL_WAIT_MS,
    });
    return ended;
  }

  /**
   * 无头上线（本机缓存一键登录 / 自主凭据两种）。
   *
   * 顺序：定分组（{@link defaultGroupFor}）→ 取 a1（{@link resolveCredential}）
   * → 结束正用着这个账号的 QQ 本体（{@link stopQqBody}）→ `createBot().start()`
   * → 本机组把 a1 写回 `login.db`（{@link writeBackA1}）。
   *
   * `device` 取自 `major.node`；`guid` 按分组取：本机组用数据根里那条（QQ 自己的
   * 设备身份），自主组用 vault 里存的那个（首次扫码生成）。两者缺一都明确失败，不猜。
   *
   * 返回登录前结束掉的 QQ 进程数，页面据此提示「已接管账号」。
   */
  async startAccount(uin: string, options: StartAccountOptions = {}): Promise<{ endedQq: number }> {
    if (this.phase === 'online' || this.phase === 'starting') {
      throw new HttpError(409, 'ALREADY_ONLINE', '已有账号在线，先退出登录再切换');
    }
    if (!/^[1-9]\d{4,19}$/.test(uin)) throw new HttpError(400, 'BAD_UIN', 'uin 不合法');

    const paths = await this.paths();
    const environment = await this.environment();

    // 1. 分组 + 凭据。页面会明确告诉我们要用哪一组；没指定时按「有自主凭据就自主」
    //    推断。分组决定用哪份设备身份，所以必须在取凭据之前定下来。
    const group = options.group ?? (await this.defaultGroupFor(uin));
    const stored = await this.resolveCredential(uin, group, paths, environment);

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

    // 本机 QQ 正用着这个账号：先结束它再上线。
    //
    // mode 2 与 QQ 双端在线技术上可行（V5），但消息会出现两处、回执语义混乱，
    // 产品口径是「一个账号只在一端」。登录页已经在账号行上显示了「QQ 本体在线，
    // 登录会先结束它」—— 用户点下去就是接管，这里不二次询问。
    const endedQq = await this.stopQqBody(derivedDbPath ?? null, uin);
    if (endedQq > 0) this.emitPhase('starting', `已结束本机 QQ 进程（${endedQq} 个），正在上线`);

    // 把控制台探测到的 wrapper 交给 bot。
    //
    // 不交的后果是 Windows 上直接报 `SIGNER_REQUIRED`：native 的
    // `resolveQqWrapperPath` 只认 `%PROGRAMFILES%\Tencent\QQNT\resources\app\
    // wrapper.node` 与 `...\resources\app\versions\<ver>\`，而 QQ NT 的真实布局是
    // `<qqRoot>\versions\<cur>\resources\app\` —— 层级相反，所以标准安装也会落空。
    // 控制台这边的 `discoverQqPaths` 是按真实布局找的，有值就必须用上。
    //
    // 配置文件里的显式值仍然优先：用户手填 `native.wrapperPath` 说明他知道自己在
    // 干什么（例如多版本共存时锁定某一个）。
    const wrapperPath = this.options.config.native?.wrapperPath ?? environment.wrapperNode ?? null;
    if (wrapperPath) {
      botConfig.native = { ...botConfig.native, wrapperPath };
    }

    // 同理，`verify_file` 的路径也交给控制台：native 的默认清单按平台换根，
    // 但它不知道便携版 / 自定义 `installDir` 的安装位置，而我们已经探到了。
    // 显式配置优先（用户手填的路径说明他就是要报那一套）。
    const verifyFile = this.options.config.session?.verifyFile ?? verifyFileOptionsFor(paths);
    if (verifyFile) {
      botConfig.session = { ...botConfig.session, verifyFile };
    }

    const bot = this.botFactory({
      config: { ...botConfig, account: { uin } },
      native: this.options.native,
      // 限定到这一组：bot 内部的 `vault.get(uin)` 与 a1 轮换回写都落到同一组，
      // 不会把自主账号的凭据写进本机组（反之亦然）。
      vault: groupScopedVault(this.options.vault, group),
      logger: this.log.child('bot'),
      onActionCall: (entry) => this.observability.recordAction(entry),
    });
    this.bot = bot;
    this.startedAccount = uin;
    this.startedGroup = group;
    this.wireBot(bot);

    await this.bringUp(bot, uin, group);
    // 本机组：a1 可能刚被服务端轮换过（`quickLogin` 返回值与入参不同），要写回
    // `login.db`，否则 QQ 本体那边会一直拿着旧 a1。失败只告警，不拖累上线。
    if (group === 'local') await this.writeBackA1(uin, stored.a1);
    this.log.info('账号已上线', { uin, group, endedQq });
    return { endedQq };
  }

  /**
   * 默认分组：vault 里有自主凭据就用自主组，否则本机组。
   *
   * 页面总是显式传组，这条只服务旧调用方（以及扫码回调之后的 `startAccount(uin)`）。
   */
  private async defaultGroupFor(uin: string): Promise<AccountGroup> {
    const self = await this.options.vault.get(uin, 'self').catch(() => undefined);
    return self && self.a1.length > 0 ? 'self' : 'local';
  }

  /**
   * `bot.start()` + 预期内错误的翻译。
   *
   * 本机凭据、扫码、有头模式三条链路共用这一段 —— 错误文案与阶段迁移必须
   * 一致，否则同一个错误在不同入口下会给出不同结论（比如 a1 失效在扫码下有
   * 提示、在手输路径下只给 INTERNAL）。
   */
  private async bringUp(bot: Bot, uin: string, group?: AccountGroup): Promise<void> {
    try {
      await bot.start();
      this.phase = 'online';
      this.emitPhase('online', '已上线');
    } catch (cause) {
      this.phase = 'offline';
      this.emitPhase('offline', messageOf(cause));
      this.log.error('账号上线失败', { uin, group, cause: messageOf(cause) });
      // a1 失效同样是**预期内**的结果，而且处置是「丢掉这份凭据、改扫码」。
      // 不在这里删的话，下一次点同一行还会拿同一串失效 a1 再试一次。
      if (isWeqBotError(cause) && cause.code === 'A1_EXPIRED') {
        // 只清这一组：本机组的 a1 失效不影响自主组同一 uin 的自持凭据。
        await this.forgetExpiredCredential(uin, group ?? this.startedGroup ?? 'self');
        throw new HttpError(
          409,
          'A1_EXPIRED',
          '该账号的 a1 已失效，已清除本机保存的凭据，请扫码登录',
        );
      }
      // 策略拒绝是**预期内**的结果，不是服务端故障：必须作为 4xx + 稳定 code
      // 给到前端，否则 `guard()` 会统一吞成 500 INTERNAL，页面只能显示一句
      // 「内部错误」—— 用户会以为是凭据坏了，去反复重新扫码。
      if (isWeqBotError(cause) && cause.code === 'ACCESS_DENIED') {
        throw new HttpError(403, 'ACCESS_DENIED', cause.message);
      }
      // 其余**预期内**的登录失败同样必须带 code + message 出去。统一走 502 而不是
      // 500：语义是「上游（登录服务器 / native）拒绝了这次登录」，是不会被读成
      // 「控制台自身出了 bug」的那个 5xx。
      //
      // 不兜这一步的后果是页面上只剩 `INTERNAL`：`guard()` 对非 HttpError 一律
      // 500 + 无 message，用户看不到「找不到 wrapper」「QQ 本体在线」等真正原因，
      // 只能反复重试。
      if (isWeqBotError(cause)) {
        throw new HttpError(502, cause.code, cause.message);
      }
      // 不是 WeqBotError 的异常确实是我们没想到的：保留「不回传 message」的
      // 口径（内部错误里可能有路径 / uin / 上游错误串），但至少要给出一句
      // 面向用户的说明，而不是让页面显示裸 code。
      throw new HttpError(502, 'LOGIN_FAILED', '登录失败：内部错误，详见控制台日志');
    }
  }

  /**
   * 取这次上线要用的凭据。
   * 分组决定**只能**从哪取：自主组只读 vault（自持 guid），本机组只读
   * `login.db`（本机 uid / guid），不准跨组兑兑。本机组的唯一例外是
   *「`login.db` 里没这个账号的 a1」：那时用 vault 里的本机镜像兜底（同组、
   *同一设备身份，不是混用）。
   */
  private async resolveCredential(
    uin: string,
    group: AccountGroup,
    paths: QqPaths,
    environment: LoginEnvironment,
  ): Promise<StoredAccount> {
    if (group === 'self') {
      const stored = await this.options.vault.get(uin, 'self');
      if (!stored || stored.a1.length === 0) {
        throw new HttpError(
          400,
          'NO_CREDENTIAL',
          '自主凭据里没有这个账号的可用 a1，请用手机扫码登录',
        );
      }
      return this.refreshDevice(stored, environment);
    }

    // 本机组：`login.db` 是唯一权威 —— 每次现解，不复用 vault 里的旧副本。
    try {
      return await this.accountFromLoginDb(uin, paths, environment);
    } catch (cause) {
      if (!(cause instanceof HttpError) || cause.code !== 'NO_CREDENTIAL') throw cause;
      const stored = await this.options.vault.get(uin, 'local');
      if (!stored || stored.a1.length === 0) throw cause;
      this.log.info('login.db 里没有可用 a1，改用 vault 里的本机凭据', { uin });
      return this.refreshDevice(stored, environment);
    }
  }

  /**
   * a1 失效后的清理：只删**这一组**的 vault 凭据，**不动 `login.db`**，也不动
   * 另一组同名账号。
   *
   * `login.db` 是 QQ 本体写的，那边的 a1 可能已经在我们不知道的时候刷新过 ——
   * 删掉它等于替用户丢了一份可能还有效的凭据。删完要立刻失效 `login.db` 行缓存，
   * 否则列表下次还显示旧快照。
   */
  private async forgetExpiredCredential(uin: string, group: AccountGroup = 'self'): Promise<void> {
    try {
      await this.options.vault.delete(uin, group);
      this.log.info('a1 已失效，已清除 vault 里这一组的凭据', { uin, group });
    } catch (cause) {
      this.log.warn('清除失效凭据失败（已忽略）', { uin, group, cause: messageOf(cause) });
    }
    this.loginRowsCache = undefined;
    void this.refreshLoginAccounts().catch((cause) => {
      this.log.warn('清理后刷新 login.db 失败（已忽略）', { cause: messageOf(cause) });
    });
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
      // 本机组：guid 就是本机数据根里那条，uid 也是 QQ 自己的。
      group: 'local',
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
   * 本机账号上线后把本次用的 a1 写回 `login.db`。
   *
   * 为什么必须写回：本机组用的就是 QQ 本体那份设备身份，`quickLogin` 成功后服务端
   * 可能轮换 a1。只写 vault 的话 QQ 本体那边一直是旧 a1 —— 下次 QQ 启动要重新登录，
   * 而我们下次一键登录又会拿旧的去换票，两边越走越远。
   *
   * 只在**轮换过**才写：没轮换时写进去的还是同一串字节，白开一次库（还要跟 QQ 抢
   * 写锁）。写失败只告警 —— a1 已经能用，不该因为回写失败把上线判失败。
   */
  private async writeBackA1(uin: string, used: Uint8Array): Promise<void> {
    const binding = this.options.binding;
    if (!binding.updateLoginDbA1) {
      this.log.debug('原生组件没有 updateLoginDbA1，跳过 a1 回写', { uin });
      return;
    }

    // `createBot` 在轮换时会把新 a1 写进本组的 vault，这里读回来就是最新的。
    let latest: StoredAccount | undefined;
    try {
      latest = await this.options.vault.get(uin, 'local');
    } catch (cause) {
      this.log.warn('读回写后的凭据失败（跳过 a1 回写）', { uin, cause: messageOf(cause) });
      return;
    }
    const a1 = latest?.a1 && latest.a1.length > 0 ? latest.a1 : used;
    if (sameBytes(a1, used)) return;

    const rows = await this.refreshLoginAccounts();
    const row = rows.find((item) => item.uin === uin);
    if (!row) {
      // 本机库里本来就没有这条（例如 QQ 重装后旧库没了），无处可写。
      this.log.debug('login.db 里没有这个账号，a1 未回写', { uin });
      return;
    }
    try {
      const result = binding.updateLoginDbA1(
        row.dbPath,
        uin,
        Buffer.from(a1).toString('hex'),
        row.algo,
      );
      // 库里内容变了，下次读账号必须重新解密，不能拿旧快照骗页面。
      this.loginRowsCache = undefined;
      if (!result.verified || result.updatedRows === 0) {
        this.log.warn('a1 回写 login.db 未通过自检', {
          uin,
          updatedRows: result.updatedRows,
          verified: result.verified,
        });
        return;
      }
      this.log.info('a1 已写回 login.db', { uin, format: result.format });
    } catch (cause) {
      this.log.warn('a1 回写 login.db 失败（已忽略）', { uin, cause: messageOf(cause) });
    }
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
    // 自主组的设备身份：**随机生成**，绝不借本机 guid。
    //
    // 借本机 guid 的后果是服务端把自主账号当成这台机器上的 QQ：本机 QQ 一登录，
    // 两边就互踢 / 触发设备确认。首次扫码生成、随账号存进 vault，之后这个账号的
    // 登录（quickLogin）一直用它；重新扫码 = 换设备身份（与 QQ 自己的扫码语义一致）。
    const guid = randomGuid();

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
      // 扫码成功后直接上线；这一条一定是自主组。失败由调用方从 `startAccount`
      // 的错误里看到。
      await this.startAccount(result.uin, { group: 'self' });
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

  /**
   * 扫码成功后落盘：进 **`self` 组**，带上本次扫码用的设备 guid。
   *
   * `guid` 必须是这次 `qrLogin` 实际传进去的那个 —— 服务端下发的 a1 就绑在它上面，
   * 存成别的（例如从本机数据根读到的 guid）下次换票会直接失败。
   *
   * 同一个 uin 如果已有本机组凭据（QQ 本体也在用这个号），**不动它**：两组在
   * vault 里是两个文件，本机组那份由 `login.db` 刷新。
   */
  private async persistQrAccount(
    result: QuickLoginResult,
    environment: LoginEnvironment,
    guid: string,
  ): Promise<void> {
    const existing = await this.options.vault.get(result.uin, 'self');
    const device = deviceProfileOf(environment);
    await this.options.vault.put({
      uin: result.uin,
      uid: result.uid ?? existing?.uid ?? '',
      // 登录过程中服务端可能下发新 a1；没有就沿用旧值（没有则明确报错）。
      a1:
        result.a1 && result.a1.length > 0
          ? new Uint8Array(result.a1)
          : (existing?.a1 ?? new Uint8Array()),
      guid,
      group: 'self',
      device: existing?.device ?? device,
      a1Origin: 'qr',
    } satisfies StoredAccount);
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
    const group = this.startedGroup;
    this.bot = undefined;
    this.startedAccount = undefined;
    this.startedGroup = undefined;
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
    // 只删在线账号那一组：同 uin 的本机 / 自主凭据是两个独立身份，不能一起删。
    // 有头模式没有组（不碰 vault）—— 不能借此删掉同名的自主凭据。
    if (options.forgetCredential && uin && group) {
      try {
        await this.options.vault.delete(uin, group);
        this.log.info('凭据已删除', { uin, group });
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
      // 长跑掉线重登时 a1 可能已经过期：bot 会以 `credential-expired` 直接停下，
      // 此时不能只把 phase 标成 offline —— 要按「手动登录失败」那套清理走一遍，
      // 并把页面推回登录页的扫码 tab。
      bot.events.on('offline', (event) => {
        if (event.reason !== 'credential-expired') return;
        const uin = this.startedAccount;
        this.observability.recordEvent(event);
        void this.handleCredentialExpired(uin);
      }),
      // 登录进度：上线期间页面要能显示「请在手机上确认」这类提示。
      // 只在 starting 阶段转发 —— 长跑重登时页面在看控制台，这条事件没有用处，
      // 反而会把「已上线」的界面弄成不确定状态。
      bot.events.on('login-progress', (event) => {
        if (this.phase !== 'starting') return;
        this.emitProgress(event.event);
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

  private emitPhase(phase: ConsolePhase, detail?: string, notice?: ConsoleNotice): void {
    const event: ConsoleStateEvent = {
      phase,
      at: Date.now(),
      ...(detail ? { detail } : {}),
      ...(notice ? { notice } : {}),
    };
    this.events.emit('console', event as never);
  }

  private emitQr(snapshot: QrSnapshot): void {
    this.events.emit('console', { qr: snapshot } as never);
  }

  /**
   * 推一条登录进度。
   *
   * 不带 `phase`：页面靠 `progress` 字段识别，`app.tsx` 收到没有 `phase` 的
   * 事件不会误改页面阶段。`at` 必须带 —— `ConsoleStateEvent` 的 SSE 形状里它是必填。
   */
  private emitProgress(progress: LoginProgressEvent): void {
    this.events.emit('console', { at: Date.now(), progress } as never);
  }

  /**
   * a1 失效后的统一收尾（消息里的两种入口共用）：清 vault → 让出账号 → 推登录页。
   *
   * 只清 vault，`login.db` 原样保留（见 {@link forgetExpiredCredential}）。
   */
  private async handleCredentialExpired(uin: string | undefined): Promise<void> {
    const bot = this.bot;
    const group = this.startedGroup;
    this.bot = undefined;
    this.startedAccount = undefined;
    this.startedGroup = undefined;
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];
    this.received = 0;
    this.sent = 0;
    this.heartbeats.length = 0;
    this.cachedNickname = undefined;
    // bot 自己已经停过了（offline 是 stop() 里发的），这里只兜底等它收尾。
    if (bot) await bot.stop('credential-expired').catch(() => undefined);
    if (uin && group) await this.forgetExpiredCredential(uin, group);
    this.phase = 'no-account';
    this.emitPhase(
      'no-account',
      'a1 已失效，已清除本机保存的凭据',
      uin ? { kind: 'a1-expired', uin } : undefined,
    );
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

    // 两组都可能持有这个 uin（同一账号既能本机登录也能扫码），先自主后本机 ——
    // 两边 uid 一样，取哪个都不影响结果，但不要因为一组没有就当我们不知道。
    const stored =
      (await this.options.vault.get(uin, 'self')) ?? (await this.options.vault.get(uin, 'local'));
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
        const cipher: LoginAlgo = {
          pageHmacAlgorithm: algo.pageHmacAlgorithm,
          kdfHmacAlgorithm: algo.kdfHmacAlgorithm,
        };
        // `dbPath` / `algo` 一眼不发给页面：回写 a1 时要拿它们重新开同一个库。
        rows.push(
          ...binding
            .decryptLoginDb(dbPath, cipher)
            .map((row) => ({ ...row, dbPath, algo: cipher })),
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

/** 解开 `login.db` 用到的 HMAC 算法（回写 a1 时原样复用）。 */
interface LoginAlgo {
  pageHmacAlgorithm: string;
  kdfHmacAlgorithm: string;
}

interface LoginRow {
  uin: string;
  uid: string;
  /** 这一行来自哪个 `login.db`。只在服务端用（回写 a1），不发给页面。 */
  dbPath: string;
  algo: LoginAlgo;
  avatarUrl?: string;
  userName?: string;
  lastLoginAt?: number;
  a1Payload?: string | null;
  guid?: string | null;
}

/**
 * 自主组的设备 guid：32 位小写 hex。
 *
 * 必须是随机的：本机 guid 是本机 QQ 的设备身份，借给自主账号用会让服务端把两边
 * 当成同一台设备（互相顶下线 / 反复设备确认）。
 */
function randomGuid(): string {
  return randomBytes(16).toString('hex');
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
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

/**
 * 进程名是否是 QQ 本体（三端命名）：`QQ` / `QQ.exe`（Windows / macOS）或 `qq`
 * （Linux `/proc/<pid>/comm`）。
 *
 * 与 nt_helper 的 `is_qq_process_name` 同一条规则：不剥 `.exe` 会漏掉 Windows，
 * 不转小写会漏掉 Linux。名字拿不到（空串）一律不当成 QQ。
 */
/** 账号在 QQ 本体里的状态：`online` 未知时省略，`pid` 拿不到时省略。 */
interface QqAccountState {
  online?: boolean;
  pid?: number;
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

/**
 * 有头模式的错误 → HTTP。
 *
 * `ELEVATION_REQUIRED` 必须是稳定的 409 + code：页面靠它弹提权框。如果落到
 * `guard()` 的兜底（500 INTERNAL），用户只会看到一句「内部错误」，而实际上
 * 他只需要输一次密码。
 */
function attachHttpError(cause: unknown): HttpError {
  if (cause instanceof HttpError) return cause;
  if (cause instanceof AttachError) {
    const message = cause.detail ? `${cause.message}。${cause.detail}` : cause.message;
    switch (cause.code) {
      case 'ELEVATION_REQUIRED':
        return new HttpError(409, cause.code, message);
      case 'ELEVATION_FAILED':
        return new HttpError(403, cause.code, message);
      case 'PROCESS_GONE':
        return new HttpError(409, cause.code, message);
      case 'NATIVE_MISSING_CAPABILITY':
        return new HttpError(501, cause.code, message);
      default:
        return new HttpError(502, cause.code, message);
    }
  }
  return new HttpError(502, 'ATTACH_FAILED', messageOf(cause));
}
