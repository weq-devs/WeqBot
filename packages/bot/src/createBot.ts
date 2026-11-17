/**
 * `createBot()` —— 门面层，也是 WeQ 嵌入时的唯一入口。
 *
 * 组装顺序是刻意固定的（每一步失败后的动作不同，见 `@weqbot/session` 的状态机）：
 *
 *   native 能力探测 → 预检 → 取 a1 → quickLogin → openSession(mode 2) → 挂 sink → 在线
 *
 * 本层只和 `sessionId` 打交道，**不接触 pid**。这一层也**不 import 任何 `.node`**，
 * 不 import `@weqbot/node`：宿主把 native 端口递进来。WeQ 传
 * `adaptNativeBinding(platform.native.ntHelper)`；独立进程传加载器读出的同一份产物。
 *
 * 推送 / 状态两条 sink 都在这里接：
 *   - 推送帧 → `@weqbot/protocol/push` 解码 → `PushBridge` → `BotEvent`；
 *   - 状态事件 → 状态机（`kicked` 终止；`closed` 按网络掉线走退避重登）。
 */

import { hostname, release } from 'node:os';
import {
  bytesEqual,
  createLogger,
  isWeqBotError,
  TypedEventBus,
  WeqBotError,
  type Logger,
} from '@weqbot/common';
import {
  inspectNative,
  parseLoginProgress,
  type DeviceProfile,
  type NativePort,
  type OpenedSession,
  type SessionStatusEvent,
  type SsoSessionConfig,
} from '@weqbot/wire';
import type {
  BotEventMap,
  CredentialVault,
  OfflineReason,
  SessionState,
  StoredAccount,
} from '@weqbot/session';
import { IdentityCache, PushBridge, SessionStateMachine } from '@weqbot/session';
import { createOneBotAdapter, type OneBotAdapter } from '@weqbot/onebot';
import type { ProtocolClient } from '@weqbot/protocol';
import { createOidbWebCredentials, createProtocolClient } from '@weqbot/protocol';
import type { BotConfig, BotOneBotConfig } from './config';
import { logBotEvent } from './event-log';
import { createMediaUrlResolver } from './media-url';
import { createProtocolBackend } from './onebot-backend';
import { generateSecToken } from './sec-token';

/**
 * 有头模式（attach）的会话物料。
 *
 * 全部来自**运行中 QQ 进程的内存**（`scanSessionMaterial`），只在本进程内活一次，
 * 不进 vault、不落盘、不进日志。宿主（`@weqbot/node` 的控制台）负责提权与扫描，
 * 本包只消费结果。
 *
 * 与 mode 2 的区别是语义上的：这里不 login、不注册、不发 `UnRegister`。账号的在线
 * 状态归 QQ 所有，我们只是搭它的 SSO 通道发协议包。因此 QQ 退出 = 会话结束，
 * 不能自动重登（重登等于替用户重新登录一次 QQ）。
 */
export interface AttachMaterial {
  /** 正在运行、持有该账号会话的 QQ 进程。 */
  pid: number;
  /** 扫出来的账号 uin。必须与 `config.account.uin` 一致（错号接入是最危险的失误）。 */
  uin: string;
  /** 账号 uid（`u_...`）；配置里只有 uin。 */
  uid: string;
  /** 设备 guid（离线从数据根读）。mode 1 只用于 SSO 头，不参与注册。 */
  guid: string;
  /** a2（hex）。 */
  a2: string;
  /** d2（hex）。 */
  d2: string;
  /** d2Key（32 位 hex）。 */
  d2Key: string;
  /**
   * QQ 自己的 `SecToken`（12 字符 base64 原文）。
   *
   * **原样透传，不轮换**：这串由 QQ 持有并参与它自己的签名。我们自己生成一个
   * 只会让两边算出不同的包签名。
   */
  secToken?: string;
  /** SSO 头字段，取运行中 QQ 的 `major.node`。 */
  subAppId: number;
  clientVersion?: string;
  qua?: string | null;
  /** 运行中 QQ 进程的 `wrapper.node`；不给时退回配置 / 静态探测。 */
  wrapperPath?: string;
}

export interface CreateBotOptions {
  config: BotConfig;
  /** 宿主注入的原生端口。 */
  native: NativePort;
  vault: CredentialVault;
  /**
   * 有头模式：借用运行中的 QQ 会话（mode 1）。
   *
   * 给了它就**完全不碰 vault / quickLogin** —— 不换票、不注册、不发 UnRegister。
   * 与 `config.qq.dbPath` 的「QQ 本体不能在线」红线互斥（有头模式的前提恰恰是 QQ
   * 在线），所以 `assertQqOffline` 在这条链路上不执行。
   */
  attach?: AttachMaterial;
  logger?: Logger;
  /** 覆盖 secToken 生成（测试 / 逆向实验用）。 */
  secToken?: (account: StoredAccount) => string;
  /**
   * OneBot action 调用观测钩子（WebUI 日志 / 调试页）。
   *
   * 透传给 `createOneBotAdapter`；本层不解释它，也不为它改变任何行为。
   */
  onActionCall?(entry: {
    ts: number;
    action: string;
    params: Record<string, unknown>;
    retcode: number;
    status: 'ok' | 'failed';
    latencyMs: number;
    transport: 'ws' | 'http' | 'webui';
    client: string;
  }): void;
}

export interface Bot {
  readonly uin: string;
  readonly state: SessionState;
  /** 当前 native 会话句柄；未上线时为 undefined。 */
  readonly sessionId: number | undefined;
  readonly events: TypedEventBus<BotEventMap>;
  /** 上线后可用的协议客户端；未上线时为 undefined。 */
  readonly protocol: ProtocolClient | undefined;
  /** OneBot 适配器；未配置 `config.onebot` 时为 undefined。 */
  readonly onebot: OneBotAdapter | undefined;
  /**
   * 观测快照：会话 / 重连 / SecToken / 设备档案。
   *
   * WebUI 总览用。**不包含任何凭据**（a1 / a2 / d2 / d2Key / secToken 都不在里面）。
   */
  readonly snapshot: BotSnapshot;
  start(): Promise<void>;
  stop(reason?: OfflineReason): Promise<void>;
  /** 立即原地轮换 `SecToken`（不重连、不重新登录）。 */
  refreshSecToken(): Promise<void>;
  /**
   * 只重启 OneBot 网络适配器，**不动会话**（WebUI 改网络配置用）。
   *
   * 传入的配置会替换 `createBot` 时的那一份，随后从现在起生效。失败会把旧适配器
   * 恢复回来并抛出 —— 不能因为改错一个端口就把整个 OneBot 面搞没。
   */
  reloadOneBot(config?: BotOneBotConfig): Promise<void>;
}

/** 总览页需要的观测数据；不含凭据。 */
export interface BotSnapshot {
  uin: string;
  uid?: string;
  state: SessionState;
  /** 当前 native 会话 id（未上线时 undefined）。 */
  sessionId?: number;
  /** 进入在线状态的时刻（ms）；不在线时 undefined。 */
  onlineSince?: number;
  device?: DeviceProfile;
  /** 本次进程内重连 / 重登次数。 */
  reconnects: number;
  /** SecToken 下次轮换时刻（ms）；关闭轮换或未排期时 undefined。 */
  secTokenRotatesAt?: number;
  /** 本次进程启动时刻（ms）。 */
  startedAt: number;
}

export function createBot(options: CreateBotOptions): Bot {
  const { config, native, vault } = options;
  const log = options.logger ?? createLogger('bot', { level: config.log?.level ?? 'info' });
  /** 收到的消息 / 事件专用子日志器：终端与落盘里一眼能按 scope 过滤。 */
  const eventLog = log.child('event');
  const events = new TypedEventBus<BotEventMap>();
  const machine = new SessionStateMachine();
  const uin = config.account.uin;
  /**
   * uid ↔ uin 观测缓存。推送层与 OneBot 后端共用同一份：消息里看到的 uid，
   * 撤回 / `@` / 群管理动作马上就能反查到 uin，否则这些 action 只能报
   * 「未观测到 uid」。重登不清空（同一批联系人仍然有效）。
   */
  const identity = new IdentityCache();

  let session: OpenedSession | undefined;
  let protocol: ProtocolClient | undefined;
  let pushBridge: PushBridge | undefined;
  let offPush: (() => void) | undefined;
  let offStatus: (() => void) | undefined;
  let storedAccount: StoredAccount | undefined;
  let onebot: OneBotAdapter | undefined;
  /** 本实例是否走有头模式：决定重登与 SecToken 轮换的行为。 */
  const attach = options.attach;
  /** OneBot 后端：上线后用来预热昵称表（好友 / 群 / 登录信息）。 */
  let backend: ReturnType<typeof createProtocolBackend> | undefined;
  /** 当前账号 uid（登录后才有）。 */
  let selfUid: string | undefined;
  let tokenTimer: ReturnType<typeof setTimeout> | undefined;
  let reloginTimer: ReturnType<typeof setTimeout> | undefined;
  let reloginAttempts = 0;
  /** 本次进程内累计的重连次数（含成功与失败的重登尝试）。 */
  let reconnects = 0;
  let onlineSince: number | undefined;
  let secTokenRotatesAt: number | undefined;
  /** 当前生效的 OneBot 配置；`reloadOneBot` 会替换它。 */
  let onebotConfig: BotOneBotConfig | undefined = config.onebot;
  const startedAt = Date.now();
  /** 主动 stop 期间忽略 native 的 `closed`，避免自己触发重登。 */
  let stopping = false;

  machine.onChange((change) => {
    log.info('状态', {
      from: change.from,
      to: change.to,
      ...(change.detail ? { detail: change.detail } : {}),
    });
    events.emit('state', { type: 'state', ...change });
  });

  const capabilities = inspectNative(native);

  /** 预检：能力 + 平台 + 凭据可用性。失败信息要能让用户知道去修什么。 */
  async function preflight(account: StoredAccount | undefined): Promise<void> {
    capabilities.requireAll(
      ['sendPacket', 'sendOidb', 'quickLogin', 'openSession', 'pushSink'],
      'mode 2 需要带 openSession / pushSink 的构建（P2 起才有）',
    );
    if (!account) {
      throw new WeqBotError('LOGIN_FAILED', `凭据库里没有 ${uin}，需要先登录一次`, {
        fields: { uin },
      });
    }
    if (account.a1.length === 0) {
      throw new WeqBotError('CREDENTIAL_CORRUPT', `${uin} 的 a1 为空`, { fields: { uin } });
    }
    log.info('预检通过', { uin, capabilities: capabilities.list() });
  }

  /**
   * 产品红线：QQ 本体在线时不允许 mode 2。
   *
   * native 的 `openSession` **不替我们检查** QQ 本体（只查自己进程内的 Owned
   * 会话），所以必须在调用前自己查。`dbPath` 由宿主配置提供；没有配置时只能
   * 告警继续 —— 独立部署应尽量配置。
   */
  async function assertQqOffline(): Promise<void> {
    const dbPath = config.qq?.dbPath;
    if (!dbPath) {
      log.warn(
        '未配置 config.qq.dbPath，跳过 isQqLoggedIn 预检（mode2 与 QQ 互踢风险由宿主保证）',
        {
          uin,
        },
      );
      return;
    }
    if (!native.isQqLoggedIn) {
      // 宿主既然配置了 dbPath，就说明要求执行这条红线；缺能力时失败而不是跳过。
      throw new WeqBotError(
        'NATIVE_MISSING_CAPABILITY',
        '配置了 config.qq.dbPath，但 native 缺少 isQqLoggedIn，无法保证不与 QQ 互踢',
        { fields: { uin, dbPath } },
      );
    }
    if (await native.isQqLoggedIn(dbPath)) {
      throw new WeqBotError('ALREADY_ONLINE', `QQ 本体在线，不能用 mode 2 上线 ${uin}`, {
        fields: { uin, dbPath },
      });
    }
  }

  function makeSecToken(account: StoredAccount): string {
    return (options.secToken ?? (() => generateSecToken()))(account);
  }

  /**
   * 等首屏同步到位。
   *
   * native 的 `openSession` 最多等 15s；慢账号在这之后才收敛。这里按
   * `config.session.syncGraceMs`（默认 15s）轮询 `getSession`，拿到 `synced`
   * 就继续上线。没有 `getSession` 能力时直接返回 false —— 不能靠猜。
   */
  async function waitForSynced(sessionId: number): Promise<boolean> {
    if (!native.getSession) return false;
    const graceMs = config.session?.syncGraceMs ?? 15_000;
    if (graceMs <= 0) return false;
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        const info = await native.getSession(sessionId);
        if (info?.state === 'closed') return false;
        if (info?.synced) return true;
      } catch (cause) {
        log.warn('查询首屏同步状态失败（继续等）', { uin, cause });
      }
    }
    return false;
  }

  /**
   * 原地轮换 `SecToken`。token 只是签名素材，换掉后下一个包立即生效；
   * 不重连、不重新登录。长跑时由定时器每 24h 调一次。
   */
  async function refreshSecToken(): Promise<void> {
    if (!session) {
      throw new WeqBotError('SESSION_CLOSED', 'bot 尚未上线，无法轮换 SecToken');
    }
    if (!native.setSecToken) {
      throw new WeqBotError(
        'NATIVE_MISSING_CAPABILITY',
        'native 缺少 setSecToken，无法原地轮换 SecToken',
      );
    }
    if (!storedAccount) {
      throw new WeqBotError('LOGIN_FAILED', '账号凭据尚未加载，无法轮换 SecToken');
    }

    const token = makeSecToken(storedAccount);
    const ok = await native.setSecToken(session.sessionId, token);
    if (!ok) {
      throw new WeqBotError('SESSION_CLOSED', `会话 ${session.sessionId} 已关闭，SecToken 未轮换`);
    }
    log.info('SecToken 已原地轮换', { uin });
  }

  function scheduleTokenRotation(): void {
    if (machine.isTerminal) return;
    const rotateMs = config.secToken?.rotateMs ?? 24 * 60 * 60 * 1000;
    if (rotateMs <= 0) {
      secTokenRotatesAt = undefined;
      return;
    }
    if (!native.setSecToken) {
      log.warn('native 缺少 setSecToken，长跑将无法轮换 SecToken', { uin });
      return;
    }

    secTokenRotatesAt = Date.now() + rotateMs;
    tokenTimer = setTimeout(() => {
      void refreshSecToken()
        .catch((cause) => log.warn('SecToken 轮换失败', { uin, cause }))
        .finally(scheduleTokenRotation);
    }, rotateMs);
    tokenTimer.unref?.();
  }

  /** 释放当前会话（sink / 句柄 / 定时器），不改状态机。 */
  async function teardownSession(reason: string): Promise<void> {
    await stopOneBot();
    if (tokenTimer) {
      clearTimeout(tokenTimer);
      tokenTimer = undefined;
    }
    offPush?.();
    offPush = undefined;
    offStatus?.();
    offStatus = undefined;
    const current = session;
    session = undefined;
    protocol = undefined;
    pushBridge = undefined;
    if (current && native.closeSession) {
      try {
        await native.closeSession(current.sessionId, reason);
      } catch (cause) {
        log.warn('关闭会话失败（忽略）', { uin, cause });
      }
    }
  }

  /** `logged-in` 之后的全部动作：openSession → sink → online。 */
  async function bringOnline(stored: StoredAccount): Promise<void> {
    // 每次（含重登）上线前都检查 QQ 本体：中途 QQ 登录回来时不能抢。
    await assertQqOffline();
    // 登录命令同样要签名：wrapper 路径必须在 quickLogin 之前拿到。
    const wrapperPath =
      config.native?.wrapperPath ??
      (native.resolveWrapperPath ? await native.resolveWrapperPath() : null);
    if (!wrapperPath) {
      throw new WeqBotError(
        'SIGNER_REQUIRED',
        '找不到 wrapper.node，mode 2 无法签名；请配置 config.native.wrapperPath',
        { fields: { uin } },
      );
    }
    const loginOs = NATIVE_OS[stored.device.os];

    machine.transition('logging-in', 'quickLogin(a1)');
    const login = await native.quickLogin!(
      {
        uin,
        a1: stored.a1,
        guid: stored.guid,
        uid: stored.uid || null,
        appId: stored.device.appId,
        subAppId: stored.device.subAppId,
        wrapperPath,
        os: loginOs.os,
        platform: loginOs.platform,
        qua: stored.device.qua,
        clientVersion: stored.device.clientVersion,
        // native 侧这两项可以是 None，但真机指纹需要稳定值：vault 没存就用本机。
        deviceName: stored.device.deviceName ?? hostname(),
        kernelVersion: stored.device.kernelVersion ?? release(),
      },
      // 进度回调：**异常设备确认是唯一会「安静地等 45 秒」的阶段**，宿主不
      // 显示这条事件就只剩转圈。事件里的认证物料在这一层被丢掉。
      (_error, event) => {
        const progress = parseLoginProgress(event);
        if (!progress) return;
        log.info('登录进度', { uin, stage: progress.kind, detail: progress.message });
        events.emit('login-progress', { type: 'login-progress', event: progress, at: Date.now() });
      },
    ).catch((cause: unknown) => {
      throw normalizeLoginError(cause, uin);
    });

    // EasyLogin 不回传 uid（QR / classic 会）；vault / 宿主配置仍是权威来源。
    const uid = login.uid || stored.uid;
    if (!uid) {
      throw new WeqBotError('LOGIN_FAILED', `${uin} 既没有登录返回的 uid，也没有 vault 里的 uid`, {
        fields: { uin },
      });
    }
    log.info('换票成功', { uin, uid });
    selfUid = uid;
    identity.observe(uid, uin);

    // 服务端可能在登录过程中轮换 a1；拿到就写回，避免下次还用旧值。
    if (login.a1 && login.a1.length > 0 && !bytesEqual(login.a1, stored.a1)) {
      try {
        await vault.put({ ...stored, a1: login.a1 });
        storedAccount = { ...stored, a1: login.a1 };
        log.info('a1 已轮换并写回 vault', { uin });
      } catch (cause) {
        log.warn('a1 轮换写回 vault 失败', { uin, cause });
      }
    }

    machine.transition('logged-in', 'a2/d2 已就绪（仅内存）');

    const device: DeviceProfile = stored.device;
    const sessionConfig: SsoSessionConfig = {
      uin,
      uid,
      a2: login.a2,
      d2: login.d2,
      d2Key: login.d2Key,
      guid: stored.guid,
      subAppId: device.subAppId,
      clientVersion: device.clientVersion,
      qua: device.qua,
      secToken: makeSecToken(stored),
    };

    machine.transition('registering', 'openSession(mode=2)');
    const opened = await native.openSession!({
      session: sessionConfig,
      mode: 2,
      signer: { wrapperPath },
      device,
    });

    if (!Number.isInteger(opened.sessionId) || opened.sessionId < 1) {
      throw new WeqBotError('REGISTER_FAILED', `native 返回了非法会话 ID ${opened.sessionId}`);
    }
    if (!opened.registered) {
      throw new WeqBotError('REGISTER_FAILED', 'openSession 返回但注册未成功', {
        fields: { sessionId: opened.sessionId, state: opened.state },
      });
    }
    if (!opened.synced) {
      // 慢账号：native 的 15s 到了但首屏还没收敛。再等一段，仍不到才失败。
      const synced = await waitForSynced(opened.sessionId);
      if (!synced) {
        if (native.closeSession) {
          await native.closeSession(opened.sessionId, 'sync-timeout').catch(() => undefined);
        }
        throw new WeqBotError('REGISTER_FAILED', '首屏同步超时，未上线（已关闭会话）', {
          fields: { sessionId: opened.sessionId },
        });
      }
      opened.synced = true;
      opened.state = 'online';
    }
    await connect(opened, uid, '已注册且首屏同步完成');
  }

  /**
   * 有头模式：用扫出来的物料借 QQ 的会话（mode 1）。
   *
   * 与 {@link bringOnline} 的区别是**没有登录**：不读 vault、不 `quickLogin`、
   * 不注册、不发 `UnRegister`。账号的在线状态完全归 QQ 所有，我们只是搭它的
   * SSO 通道发协议包 —— 这也是它能在 QQ 在线时使用的原因（mode 2 会被
   * `assertQqOffline` 拦下）。
   */
  async function bringOnlineAttached(material: AttachMaterial): Promise<void> {
    capabilities.requireAll(
      ['sendPacket', 'sendOidb', 'openSession', 'pushSink'],
      '有头模式需要带 openSession / pushSink 的构建',
    );
    if (material.uin !== uin) {
      throw new WeqBotError(
        'LOGIN_FAILED',
        `有头模式扫到的账号是 ${material.uin}，但本次实例绑定的是 ${uin}`,
        { fields: { uin } },
      );
    }

    // 签名必须用**正在跑的那个** wrapper：多版本共存时磁盘上探测到的未必是它。
    const wrapperPath =
      material.wrapperPath ??
      config.native?.wrapperPath ??
      (native.resolveWrapperPath ? await native.resolveWrapperPath() : null);
    if (!wrapperPath) {
      throw new WeqBotError(
        'SIGNER_REQUIRED',
        '有头模式找不到运行中 QQ 的 wrapper.node，无法签名；请确认 QQ 仍在运行',
        { fields: { uin, pid: material.pid } },
      );
    }

    selfUid = material.uid;
    identity.observe(material.uid, uin);
    log.info('有头模式：接管运行中的 QQ 会话', {
      uin,
      pid: material.pid,
      wrapperPath,
      hasSecToken: Boolean(material.secToken),
    });

    // 状态机不允许跳步（preflight 只能去 logging-in），这里的 logging-in 表示
    // 「从 QQ 手里拿会话」而不是「换票」，但阶段语义仍然是「还没上线」。
    machine.transition('logging-in', `有头模式：读取 pid ${material.pid} 的会话`);
    machine.transition('logged-in', '已读到 QQ 的会话物料（仅内存）');
    machine.transition('registering', `openSession(mode=1, pid=${material.pid})`);

    const opened = await native.openSession!({
      session: {
        uin,
        uid: material.uid,
        a2: hexToBytes(material.a2),
        d2: hexToBytes(material.d2),
        d2Key: hexToBytes(material.d2Key),
        guid: material.guid,
        subAppId: material.subAppId,
        clientVersion: material.clientVersion,
        qua: material.qua ?? null,
        secToken: material.secToken ?? null,
      },
      mode: 1,
      signer: { wrapperPath },
    });

    if (!Number.isInteger(opened.sessionId) || opened.sessionId < 1) {
      throw new WeqBotError('REGISTER_FAILED', `native 返回了非法会话 ID ${opened.sessionId}`);
    }
    if (opened.uin && opened.uin !== uin) {
      throw new WeqBotError('LOGIN_FAILED', `native 打开的会话属于 ${opened.uin}，不是 ${uin}`, {
        fields: { uin },
      });
    }

    // mode 1 没有注册与首屏同步：`registered` / `synced` 恒 false 是预期值，
    // 不按 mode 2 的标准去校验它们。
    await connect(opened, material.uid, `已接管 pid ${material.pid} 的会话`);
  }

  /**
   * 会话就绪之后的公共接线：协议门面 / 推送桥 / 两条 sink / OneBot。
   *
   * mode 2 与有头模式共用这一段 —— 差别只在「怎么拿到 session」，拿到之后的行为
   * 必须一致，否则两条链路会慢慢漂移。
   */
  async function connect(opened: OpenedSession, uid: string, detail: string): Promise<void> {
    session = opened;
    protocol = createProtocolClient({ native, sessionId: opened.sessionId });
    pushBridge = new PushBridge({
      selfUin: uin,
      selfUid: uid,
      keepRaw: config.keepRaw ?? false,
      identity,
    });

    offPush = await native.attachPushSink!(
      opened.sessionId,
      (frame) => {
        try {
          const result = pushBridge?.handle(frame);
          if (!result) return;
          if (result.unhandled.length > 0) {
            log.debug('未建模的推送', {
              command: frame.command,
              kinds: result.unhandled.map((event) => event.kind),
            });
          }
          for (const event of result.events) {
            // 先打印再分发：日志顺序与事件顺序一致，排查时不用自己排序。
            logBotEvent(eventLog, event);
            if (event.type === 'message') events.emit('message', event.message);
            else if (event.type === 'notice') events.emit('notice', event);
            else if (event.type === 'request') events.emit('request', event);
            events.emit('event', event);
          }
        } catch (cause) {
          log.error('推送解码失败', { cause });
          events.emit('event', {
            type: 'error',
            error: new WeqBotError('UNKNOWN', '推送解码失败', { cause }),
            at: Date.now(),
          });
        }
      },
      (error) => {
        log.error('推送通道错误', { cause: error });
        events.emit('event', {
          type: 'error',
          error: new WeqBotError('UNKNOWN', '推送通道错误', { cause: error }),
          at: Date.now(),
        });
      },
    );

    machine.transition('online', detail);
    events.emit('online', { type: 'online', uin, at: Date.now() });

    if (native.attachStatusSink) {
      offStatus = await native.attachStatusSink(opened.sessionId, (event) => {
        handleStatus(event);
      });
    }

    reloginAttempts = 0;
    onlineSince = Date.now();
    // 有头模式的 SecToken 归 QQ 所有：我们自己生成一个只会让签名与 QQ 分叉。
    if (attach) {
      if (!attach.secToken) {
        log.warn('有头模式没有读到 SecToken，签名可能被服务端拒绝', { uin });
      }
    } else {
      scheduleTokenRotation();
    }
    await startOneBot();
  }

  /** 起 OneBot（若已配置）。失败只记日志：OneBot 挂了不该把会话一起拖下水。 */
  async function startOneBot(): Promise<void> {
    if (!onebotConfig || onebot) return;
    if (!protocol) return;

    try {
      // 空间 cgi 的凭据来源：纯 OIDB（`0x102a_1` → jump → `0x102a_0`），
      // 不需要 QQ 进程，也不走 pt_login（那是 WeQ 宿主的能力，见 TODO D18）。
      const webCredentials =
        onebotConfig.qzone === false
          ? undefined
          : createOidbWebCredentials({
              native: protocol.native,
              sessionId: protocol.sessionId,
              uin,
            });
      // 入站媒体：pic/ptt/video 只有 fileToken，URL 要靠 rkey 现拼（带缓存）。
      // 历史消息 / 合并转发也要用同一份解析器，否则拉回来的图片只有文件名。
      const media = createMediaUrlResolver({ protocol, logger: log });
      backend = createProtocolBackend({
        protocol,
        selfUin: uin,
        ...(selfUid ? { selfUid: selfUid } : {}),
        logger: log,
        ...(webCredentials ? { webCredentials } : {}),
        ...(onebotConfig.qzoneDomain ? { qzoneDomain: onebotConfig.qzoneDomain } : {}),
        imageUrlResolver: (element, isGroup) => media.imageUrl(element, isGroup),
        mediaUrlResolver: (element, isGroup) => media.mediaUrl(element, isGroup),
        shutdown: (reason) => stop(reason === 'bot-exit' ? 'bot-exit' : 'closed'),
        resolveUidUin: {
          uinByUid: (targetUid: string) => identity.uinOf(targetUid),
          uidByUin: (targetUin: string) => identity.uidOf(targetUin),
        },
      });
      const adapter = createOneBotAdapter({
        config: onebotConfig,
        backend,
        selfId: Number(uin),
        events: {
          on: ((event: 'event' | 'message' | 'notice', listener: never) =>
            events.on(event, listener as never)) as never,
        },
        imageUrlResolver: (element, isGroup) => media.imageUrl(element, isGroup),
        mediaUrlResolver: (element, isGroup) => media.mediaUrl(element, isGroup),
        logger: log,
        ...(options.onActionCall ? { onActionCall: options.onActionCall as never } : {}),
      });
      await adapter.start();
      onebot = adapter;
      log.info('OneBot 已启动', { port: adapter.port, actions: adapter.actions().length });
      // 昵称表在后台预热：失败不影响上线，日志里退回 uin / 短 uid。
      void seedIdentity(backend);
    } catch (cause) {
      log.error('OneBot 启动失败（会话继续）', { uin, cause });
    }
  }

  async function stopOneBot(): Promise<void> {
    const adapter = onebot;
    onebot = undefined;
    if (!adapter) return;
    try {
      await adapter.stop();
    } catch (cause) {
      log.warn('OneBot 停止失败', { uin, cause });
    }
  }

  /**
   * 换一份 OneBot 配置并重启适配器。
   *
   * 顺序是「旧的一定先停」：端口冲突本身就是最常见的失败原因，先停再起才可能
   * 复用同一个端口。旧适配器停掉后新配置起不来时，用旧配置再起一次 —— WebUI 的
   * 「保存」按钮不该把用户正在用的 OneBot 面搞没。
   */
  async function reloadOneBot(next?: BotOneBotConfig): Promise<void> {
    const previousConfig = onebotConfig;
    const previousAdapter = onebot;
    if (next !== undefined) onebotConfig = next;
    else onebotConfig = config.onebot;

    await stopOneBot();
    if (!onebotConfig) {
      log.info('OneBot 配置已清空，网络适配器全部停止', { uin });
      return;
    }
    if (!protocol) {
      log.info('会话不在线，OneBot 配置已记录，上线后生效', { uin });
      return;
    }

    try {
      await startOneBot();
      if (!onebot) throw new Error('OneBot 适配器没有起来（见上一条日志）');
    } catch (cause) {
      log.error('新 OneBot 配置启动失败，回滚到上一份', { uin, cause });
      onebotConfig = previousConfig;
      await stopOneBot();
      if (previousAdapter && previousConfig) {
        onebotConfig = previousConfig;
        await startOneBot();
      }
      throw cause;
    }
  }

  /**
   * 用 OneBot 后端的联系人 / 群列表预热昵称表。
   *
   * SnowLuma 在初始化时维护一张持久化身份表；这里不做持久化（身份缓存按约定
   * 不落盘），只在每次上线后从好友列表、群列表和登录信息里补一遍名字。
   * 消息里的群名片 / 昵称会继续增量更新，所以预热失败只降级成显示 uin。
   */
  async function seedIdentity(source: typeof backend): Promise<void> {
    if (!source) return;
    const describe = (cause: unknown): string =>
      cause instanceof Error ? cause.message : String(cause);
    try {
      const login = await source.getLoginInfo?.();
      if (login) {
        identity.observeName({ uin: login.userId, uid: login.uid ?? selfUid }, login.nickname);
      }
    } catch (cause) {
      log.debug('读取登录信息失败（昵称表跳过自身）', { cause: describe(cause) });
    }
    try {
      const friends = await source.getFriendList?.();
      for (const friend of friends ?? []) {
        // uid 一起写：私聊/输入状态/撤回的推送只带 uid，只写 uin 的名字查不到。
        identity.observeName(
          { uin: friend.userId, ...(friend.uid ? { uid: friend.uid } : {}) },
          friend.remark || friend.nickname,
        );
      }
    } catch (cause) {
      log.debug('读取好友列表失败（昵称表不完整）', { cause: describe(cause) });
    }
    try {
      const groups = await source.getGroupList?.();
      for (const group of groups ?? []) {
        identity.observeName({ uin: group.groupId }, group.groupName);
      }
    } catch (cause) {
      log.debug('读取群列表失败（昵称表不完整）', { cause: describe(cause) });
    }
  }

  function handleStatus(event: SessionStatusEvent): void {
    switch (event.kind) {
      case 'heartbeat':
        events.emit('heartbeat', { type: 'heartbeat', at: event.ts, rttMs: event.rttMs });
        break;
      case 'reconnecting':
        if (machine.state === 'online') {
          machine.transition('degraded', `第 ${event.attempt} 次重连`);
        }
        break;
      case 'reconnected':
        if (machine.state === 'degraded') machine.transition('online', 'native 已重连');
        break;
      case 'kicked':
        log.warn('被服务端踢下线', { uin, reason: event.reason });
        void stop('kicked');
        break;
      case 'closed':
        if (stopping || machine.isTerminal) break;
        if (event.reason === 'reconnect-failed') {
          // native 已经用尽自己的 5 次退避重连；再让 TS 重登会叠成 25 次。
          log.error('native 重连次数用尽，bot 下线', { uin });
          void stop('relogin-failed');
          break;
        }
        log.warn('会话被 native 关闭，按网络掉线处理', { uin, reason: event.reason });
        scheduleRelogin('network');
        break;
      case 'sink_overflow':
        log.warn('推送队列溢出，native 丢帧', { uin, dropped: event.dropped });
        break;
      default:
        break;
    }
  }

  /** 网络掉线：退避后重走 `logging-in`；次数用尽才真正下线。 */
  function scheduleRelogin(reason: OfflineReason): void {
    // 有头模式不能重登：重登等于替用户再登录一次 QQ，而 QQ 的会话本来就由它
    // 自己维护。QQ 退出 / 会话失效时直接下线，把控制权交回用户。
    if (attach) {
      log.info('有头模式不自动重登（会话归 QQ 所有）', { uin, reason });
      void stop(reason === 'network' ? 'network' : reason);
      return;
    }
    const max = config.maxReloginAttempts ?? 5;
    if (reason !== 'network' || reloginAttempts >= max) {
      void stop(reason === 'network' ? 'relogin-failed' : reason);
      return;
    }

    reloginAttempts += 1;
    reconnects += 1;
    const delay = Math.min(1000 * 2 ** (reloginAttempts - 1), 16_000);
    if (machine.state === 'online') machine.transition('degraded', `第 ${reloginAttempts} 次重登`);
    log.info('准备重登', { uin, attempt: reloginAttempts, delayMs: delay });

    reloginTimer = setTimeout(() => {
      reloginTimer = undefined;
      void (async () => {
        if (stopping || machine.isTerminal || !storedAccount) return;
        try {
          await teardownSession('relogin');
          await bringOnline(storedAccount);
        } catch (cause) {
          // a1 失效不能当网络问题退避重试：反复拿失效 a1 换票只会引发风控。
          // 直接停下，让宿主清凭据并要求用户重新登录（见 OfflineReason）。
          if (isWeqBotError(cause) && cause.code === 'A1_EXPIRED') {
            log.warn('重登时 a1 已失效，停止重试', { uin, attempt: reloginAttempts });
            void stop('credential-expired');
            return;
          }
          log.warn('重登失败', { uin, attempt: reloginAttempts, cause });
          scheduleRelogin('network');
        }
      })();
    }, delay);
    reloginTimer.unref?.();
  }

  async function start(): Promise<void> {
    if (machine.state !== 'idle') {
      throw new WeqBotError('UNKNOWN', `bot 已经在 ${machine.state}，不能重复 start`);
    }

    if (attach) {
      // 有头模式不碰 vault：会话物料直接由宿主递进来，连凭据都不读
      // （vault 里没有这个账号也不影响接管）。
      machine.transition('preflight', '有头模式：校验会话物料');
      await bringOnlineAttached(attach);
      return;
    }

    machine.transition('preflight', '读取凭据');
    const account = await vault.get(uin);
    await preflight(account);
    const stored = account as StoredAccount;
    storedAccount = stored;

    await bringOnline(stored);
  }

  async function stop(reason: OfflineReason = 'closed'): Promise<void> {
    if (machine.isTerminal) return;
    stopping = true;
    if (reloginTimer) {
      clearTimeout(reloginTimer);
      reloginTimer = undefined;
    }
    try {
      await teardownSession(reason);
    } finally {
      machine.forceClose(reason);
      events.emit('offline', { type: 'offline', reason, at: Date.now() });
      events.clear();
      stopping = false;
    }
  }

  return {
    uin,
    get state() {
      return machine.state;
    },
    get sessionId() {
      return session?.sessionId;
    },
    events,
    get protocol() {
      return protocol;
    },
    get onebot() {
      return onebot;
    },
    get snapshot(): BotSnapshot {
      return {
        uin,
        ...(selfUid ? { uid: selfUid } : {}),
        state: machine.state,
        ...(session ? { sessionId: session.sessionId } : {}),
        // `degraded` 是重连窗口：会话还没结束，在线时长要继续走，
        // 否则页面会在每次重连时跳回「在线 0 秒」。
        ...(onlineSince !== undefined &&
        (machine.state === 'online' || machine.state === 'degraded')
          ? { onlineSince }
          : {}),
        ...(storedAccount ? { device: storedAccount.device } : {}),
        reconnects,
        ...(secTokenRotatesAt !== undefined ? { secTokenRotatesAt } : {}),
        startedAt,
      };
    },
    start,
    stop,
    refreshSecToken,
    reloadOneBot,
  };
}

/**
 * native 在登录链路里抛出的错误里，哪些属于**项目策略拒绝**而非凭据问题。
 *
 * native 侧只有 napi 的 message 字符串可用（没有 `code` 字段），所以约定一个
 * 稳定的大写前缀 —— 与 `nt_helper` 的 `coded_error` 惯例一致。前缀对不上就
 * **原样返回**：不能把任意 napi 错误重新包装成 `ACCESS_DENIED`，否则「a1 失效」
 * 也会显示成「项目策略限制」，把用户引到错误的方向。
 */
const DENIED_PREFIX = 'LOGIN_DENIED:';

/**
 * a1 失效的稳定错误码（真机实测，见 `docs/architecture/credentials.md`）。
 *
 * 服务端枚举里有三个码，处置完全相同 —— 都是「这串 a1 不能再用」：
 *
 * - `140022014` EXPIRE_TICKET：过期；
 * - `140022015` KICKED_TICKET：被顶 / 失效（最常见）；
 * - `140022016` ILLEGAL_TICKET：非法（**真机见过**，文案与 015 一字不差）。
 *
 * 只认 015 的后果是真机上报 `140022016` 时归到 `LOGIN_FAILED`，WebUI 既不删
 * 失效凭据、也不跳扫码页，用户会拿同一串 a1 反复重试。
 *
 * 用带边界的正则而不是 `includes()`：相邻码 `140022017`（SEC_BEAT，缺签名）
 * 必须**不**被误判 —— 那是签名问题，重新登录也修不好。
 */
const A1_EXPIRED_CODES = ['140022014', '140022015', '140022016'] as const;
const A1_EXPIRED_PATTERNS: ReadonlyArray<{ code: string; pattern: RegExp }> = A1_EXPIRED_CODES.map(
  (code) => ({ code, pattern: new RegExp(`(^|\\D)${code}(\\D|$)`) }),
);

/** 命中的 a1 失效码（诊断用）；没命中返回 undefined。 */
function matchA1ExpiredCode(message: string): string | undefined {
  return A1_EXPIRED_PATTERNS.find((entry) => entry.pattern.test(message))?.code;
}

function normalizeLoginError(cause: unknown, uin: string): WeqBotError {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (message.startsWith(DENIED_PREFIX)) {
    return new WeqBotError(
      'ACCESS_DENIED',
      '当前构建的项目策略不允许登录该账号（与 QQ 凭据无关）',
      { cause, fields: { uin, native: message } },
    );
  }
  // a1 失效必须单独成码：它的处置是「停止重试并重新登录」，而 LOGIN_FAILED
  // 的其它成因（网络 / 风控）处置完全不同。挂到 LOGIN_FAILED 上会让上层无从分辨。
  const expiredCode = matchA1ExpiredCode(message);
  if (expiredCode) {
    return new WeqBotError('A1_EXPIRED', 'a1 已失效，需要重新登录或扫码', {
      cause,
      fields: { uin, native: message, code: expiredCode },
    });
  }
  return new WeqBotError('LOGIN_FAILED', message, { cause, fields: { uin } });
}

/** `DeviceProfile.os` → native 的 `(os, NTLoginPlatform)` 常量。 */
const NATIVE_OS: Record<DeviceProfile['os'], { os: string; platform: number }> = {
  linux: { os: 'Linux', platform: 7 },
  darwin: { os: 'Mac', platform: 5 },
  win32: { os: 'Windows', platform: 4 },
};

/**
 * hex → bytes（有头模式的物料）。
 *
 * native 的扫描接口交出来的是十六进制串，`SsoSessionConfig` 要字节。奇数长度
 * 或非 hex 字符是扫描侧的错，不能静默截断成别的值（那会让签名对不上）。
 */
function hexToBytes(hex: string): Uint8Array {
  if (hex.length === 0 || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw new WeqBotError('LOGIN_FAILED', '有头模式拿到的会话物料不是合法 hex，无法打开会话');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** 供 CLI / 测试使用的最小健康检查（不启动任何连接）。 */
export function describeBot(options: Pick<CreateBotOptions, 'config' | 'native'>): string {
  const capabilities = inspectNative(options.native);
  return [
    `account=${options.config.account.uin}`,
    `capabilities=${capabilities.list().join(',') || '(none)'}`,
    `missing=${capabilities.missing(['sendPacket', 'quickLogin', 'openSession', 'pushSink']).join(',') || '(none)'}`,
  ].join(' ');
}
