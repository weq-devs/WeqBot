/**
 * 控制通道的会话核心（与传输无关）。
 *
 * 两种宿主形态共用它：
 *
 * - `--sidecar`：dev / WeQ 拉起的一次性子进程，NDJSON over stdio，stdin 关闭即退出；
 * - `--serve`：常驻 daemon，NDJSON over unix socket，**客户端断开不退出**。
 *
 * 差别只在「怎么收发」和「谁决定退出」，所以这里是：`handle()` 收请求 + `subscribe()`
 * 广播事件 + `close()` 主动收尾。传输实现分别在 `sidecar.ts` / `daemon.ts`。
 *
 * 凭据只从控制通道进来，不读自己的 vault 之外的任何文件；a1 落 `FileCredentialVault`
 * 后立刻从内存清掉（`login` 的 params 不在闭包里保留）。
 */

import { createLogger, WeqBotError, type Logger } from '@weqbot/common';
import {
  createBot,
  type AttachMaterial,
  type Bot,
  type BotConfig,
  type BotOneBotConfig,
} from '@weqbot/bot';
import {
  CONTROL_EVENTS,
  controlEvent,
  controlFailure,
  controlSuccess,
  type ControlEnvelope,
  type ControlFailure,
  type ControlOneBotConfig,
  type ControlOneBotListener,
  type ControlOneBotState,
  type ControlObservedMessage,
  type ControlStatus,
} from '@weqbot/control';
import type { CredentialVault, StoredAccount } from '@weqbot/session';
import type { DeviceProfile, NativePort } from '@weqbot/wire';
import { maskOneBotConfig, OneBotConfigError, validateOneBotConfig } from './onebot-config';

export interface ControlHostOptions {
  /** 账号由启动时决定，控制通道拿不到第二个账号。 */
  uin: string;
  native: NativePort;
  vault: CredentialVault;
  logger?: Logger;
  /**
   * 启动期就确定的配置（`--config` 读出来的）。
   *
   * 与 `login` 里按请求组装的字段合并；这里**不接受凭据**，a1 仍然只从控制通道来。
   * `onebot` 尤其要走这条路：端口拓扑是部署形态，不该每次 login 重定。
   */
  config?: Omit<BotConfig, 'account'>;
  /** 注入点：测试用假 Bot，生产用 createBot。 */
  botFactory?: (options: Parameters<typeof createBot>[0]) => Bot;
  /** `shutdown` 应答已发、`bye` 已广播之后调用；由传输层决定是否退出进程。 */
  onShutdown?: (reason: string) => void;
}

export interface ControlHost {
  /** 处理一条信封；response 只回给请求方（`reply`），不广播。 */
  handle(envelope: ControlEnvelope, reply: (envelope: ControlEnvelope) => void): Promise<void>;
  /** 订阅广播事件（state / heartbeat / onebot / bye）；返回退订函数。 */
  subscribe(sink: (envelope: ControlEnvelope) => void): () => void;
  status(): ControlStatus;
  /** 下线并广播 `bye`（幂等）。 */
  close(reason?: string): Promise<void>;
  readonly closed: boolean;
}

export function createControlHost(options: ControlHostOptions): ControlHost {
  const log = options.logger ?? createLogger('control');
  const botFactory = options.botFactory ?? createBot;
  const sinks = new Set<(envelope: ControlEnvelope) => void>();

  let bot: Bot | undefined;
  let device: DeviceProfile | null = null;
  let closed = false;
  let lastEventAt: number | null = null;
  let starting: Promise<ControlStatus> | undefined;
  let offs: (() => void)[] = [];
  /**
   * 这个进程已经用哪条路绑定过账号。
   *
   * `login`（mode2 自建）与 `attach`（mode1 借会话）在「谁拥有账号的在线状态」
   * 上互斥 —— 两个都成功会让服务端看到两条注册路径，直接违反硬约束 2。
   * 这里用一个入口记账，比在两条链路里各写一遍守卫可靠。
   */
  let opened: 'none' | 'login' | 'attach' = 'none';
  let attachedPid: number | undefined;
  const observedMessages = new Map<string, Promise<boolean>>();

  const broadcast = (envelope: ControlEnvelope): void => {
    for (const sink of sinks) sink(envelope);
  };

  const status = (): ControlStatus => ({
    uin: options.uin,
    ...(opened === 'none' ? {} : { mode: opened === 'attach' ? 'attached' : 'standalone' }),
    ...(attachedPid === undefined ? {} : { attachedPid }),
    state: controlState(bot?.state),
    sessionId: bot?.sessionId ?? null,
    lastEventAt,
    device,
  });

  function attachBot(next: Bot): void {
    offs.push(
      next.events.on('state', (change) => {
        lastEventAt = change.at;
        broadcast(controlEvent(CONTROL_EVENTS.state, change));
      }),
      next.events.on('heartbeat', (event) => {
        lastEventAt = event.at;
        broadcast(controlEvent(CONTROL_EVENTS.heartbeat, event));
      }),
      next.events.on('event', (event) => {
        lastEventAt = Date.now();
        broadcast(controlEvent(CONTROL_EVENTS.onebot, event));
      }),
    );
  }

  async function shutdown(reason?: string): Promise<void> {
    if (closed) return;
    closed = true;
    for (const off of offs) off();
    offs = [];
    try {
      await bot?.stop('closed');
    } catch (cause) {
      log.warn('停止 bot 失败', { reason, cause });
    }
    const finalReason = reason ?? 'shutdown';
    broadcast(controlEvent(CONTROL_EVENTS.bye, { reason: finalReason }));
    options.onShutdown?.(finalReason);
  }

  async function login(params: {
    a1: string;
    guid: string;
    uid?: string;
    device?: DeviceProfile;
    qqDbPath?: string;
  }): Promise<ControlStatus> {
    if (opened === 'attach') {
      throw new WeqBotError(
        'ALREADY_ONLINE',
        '这个进程已经用有头模式接管了 QQ 的会话；自建上线（mode 2）与它互斥',
      );
    }
    if (isOnline()) return status();
    if (starting) return starting;
    if (!params.device) {
      throw new WeqBotError(
        'LOGIN_FAILED',
        '控制通道需要 device 档案（appId/subAppId/qua/clientVersion/os），否则设备指纹会漂移',
      );
    }

    const a1 = decodeA1(params.a1);
    if (a1.length === 0) throw new WeqBotError('LOGIN_FAILED', 'a1 为空');
    device = params.device;

    if (!params.uid) {
      log.warn('控制通道没有提供 uid；EasyLogin 不回传 uid，openSession 可能缺字段', {
        uin: options.uin,
      });
    }

    // 控制通道没给 uid 时保留 vault 里的旧值，别把它冲成空串。
    const existing = await options.vault.get(options.uin);
    const account: StoredAccount = {
      uin: options.uin,
      uid: params.uid ?? existing?.uid ?? '',
      a1,
      guid: params.guid,
      device: params.device,
      a1Origin: 'manual',
    };
    await options.vault.put(account);

    const qqDbPath = params.qqDbPath ?? process.env.WEQBOT_QQ_DB ?? options.config?.qq?.dbPath;
    const onebot = onebotConfigForBot();
    const config: BotConfig = {
      // 启动参数打底（onebot / session / secToken / native.wrapperPath），
      // 再被本次 login 的 qqDbPath 覆盖 —— 凭据永远不在这里。
      ...options.config,
      ...(onebot ? { onebot } : {}),
      account: { uin: options.uin },
      native: { ...options.config?.native },
      ...(qqDbPath ? { qq: { ...options.config?.qq, dbPath: qqDbPath } } : {}),
      log: options.config?.log ?? { level: 'info' },
    };

    starting = (async () => {
      const next = botFactory({
        config,
        native: options.native,
        vault: options.vault,
        logger: log,
      });
      bot = next;
      opened = 'login';
      attachBot(next);
      await next.start();
      return status();
    })();

    try {
      return await starting;
    } finally {
      starting = undefined;
    }
  }

  /**
   * 有头模式（mode 1）：宿主已经持有 QQ 本体的会话，直接搭它的 SSO 通道。
   *
   * 与 {@link login} 的三处差别：
   *
   * 1. **不碰 vault**：a2/d2/d2Key 是运行期易失物，存下来没有任何意义，还会
   *    增加泄漏面（硬约束 4 只允许持久化 a1 + guid + 设备档案）；
   * 2. **不发 `UnRegister`**：账号的在线状态归 QQ 所有，我们只是借道；
   * 3. **QQ 必须在线**：所以这里不跑 `isQqLoggedIn` 预检（那是 mode2 的门禁）。
   */
  async function attachLogin(params: {
    pid: number;
    uin: string;
    uid: string;
    guid: string;
    a2: string;
    d2: string;
    d2Key: string;
    secToken?: string;
    subAppId: number;
    clientVersion?: string;
    qua?: string | null;
    wrapperPath?: string;
    device?: DeviceProfile;
  }): Promise<ControlStatus> {
    if (opened === 'login') {
      throw new WeqBotError('ALREADY_ONLINE', '这个进程已经自建上线（mode 2）；有头模式与它互斥');
    }
    if (isOnline()) return status();
    if (starting) return starting;

    // 错号接入是最危险的失误：宿主给的 uin 与进程绑定值不一致时直接拒绝，
    // 不要在别人的账号上动作。
    if (params.uin !== options.uin) {
      throw new WeqBotError(
        'LOGIN_FAILED',
        `控制通道提供的 uin 是 ${params.uin}，但这个进程绑定的是 ${options.uin}`,
        { fields: { expected: options.uin, actual: params.uin } },
      );
    }
    if (!Number.isInteger(params.pid) || params.pid <= 0) {
      throw new WeqBotError('LOGIN_FAILED', `pid 不合法：${params.pid}`);
    }
    if (!Number.isSafeInteger(params.subAppId) || params.subAppId <= 0) {
      throw new WeqBotError('LOGIN_FAILED', 'subAppId 必须是正整数（取自 major.node）');
    }

    const material: AttachMaterial = {
      pid: params.pid,
      uin: params.uin,
      uid: params.uid,
      guid: params.guid,
      a2: params.a2,
      d2: params.d2,
      d2Key: params.d2Key,
      ...(params.secToken ? { secToken: params.secToken } : {}),
      subAppId: params.subAppId,
      ...(params.clientVersion ? { clientVersion: params.clientVersion } : {}),
      ...(params.qua !== undefined ? { qua: params.qua } : {}),
      ...(params.wrapperPath ? { wrapperPath: params.wrapperPath } : {}),
    };

    // 设备档案只给控制通道的 `status` 看（有头模式不靠它注册）。宿主没提供时
    // 用 subAppId 拼一份最小档案，不要伪造 os / platform —— 那会让排障日志说谎。
    if (params.device) device = params.device;

    const onebot = onebotConfigForBot();
    const config: BotConfig = {
      ...options.config,
      ...(onebot ? { onebot } : {}),
      account: { uin: options.uin },
      native: { ...options.config?.native },
      log: options.config?.log ?? { level: 'info' },
    };

    // 宿主最容易误判的一点：attach 成功后 `CONTROL_EVENTS.onebot` 永远安静。
    // 在日志里说清楚，比等对方提 issue 强。
    log.info('mode 1 不订阅 QQ 服务端推送；可接收宿主数据库观察', {
      uin: options.uin,
      pid: params.pid,
    });

    starting = (async () => {
      const next = botFactory({
        config,
        native: options.native,
        vault: options.vault,
        logger: log,
        attach: material,
      });
      bot = next;
      opened = 'attach';
      attachedPid = params.pid;
      attachBot(next);
      await next.start();
      return status();
    })();

    try {
      return await starting;
    } finally {
      starting = undefined;
    }
  }

  /** 上线前通过 `onebot.set` 下发的配置；下次 `createBot` 时生效。 */
  let pendingOneBot: BotOneBotConfig | undefined;

  /** 构造 bot 时用的 OneBot 配置。 */
  function onebotConfigForBot(): BotOneBotConfig | undefined {
    return pendingOneBot ?? options.config?.onebot;
  }

  /** 当前生效的 OneBot 配置；没配过时为 undefined。 */
  function currentOneBotConfig(): BotOneBotConfig | undefined {
    return bot?.onebotConfig ?? onebotConfigForBot();
  }

  function onebotState(): ControlOneBotState {
    const config = currentOneBotConfig();
    const listeners: ControlOneBotListener[] = (bot?.onebot?.networks() ?? []).map((snapshot) => ({
      kind: snapshot.kind,
      name: snapshot.name,
      endpoint: snapshot.endpoint,
      state: snapshot.state,
      ...(snapshot.port !== undefined ? { port: snapshot.port } : {}),
      clients: snapshot.clients,
      ...(snapshot.error ? { error: snapshot.error } : {}),
    }));
    return {
      configured: config !== undefined,
      config: (maskOneBotConfig(config) as ControlOneBotConfig | undefined) ?? null,
      listeners,
    };
  }

  async function setOnebot(config: ControlOneBotConfig | null): Promise<ControlOneBotState> {
    let next: BotOneBotConfig | undefined;
    if (config !== null) {
      try {
        next = validateOneBotConfig(config, currentOneBotConfig());
      } catch (cause) {
        if (cause instanceof OneBotConfigError) {
          throw new WeqBotError(
            cause.code === 'PORT_CONFLICT' ? 'ONEBOT_LISTEN_FAILED' : 'LOGIN_FAILED',
            cause.message,
            { fields: { code: cause.code } },
          );
        }
        throw cause;
      }
    }

    if (!bot) {
      // 还没上线：只记在内存里，上线时随 `createBot` 一起生效。daemon 不负责
      // 落盘 —— 宿主才是配置的权威来源，重启后它会重新下发（见 embedding.md）。
      pendingOneBot = next;
      return onebotState();
    }

    // `reloadOneBot` 保证「先停旧、失败回滚旧配置再抛」，所以这里不需要自己
    // 兜底；失败时 `bot.onebotConfig` 仍是上一份，`onebotState()` 读到的也对。
    await bot.reloadOneBot(next);
    pendingOneBot = next;
    return onebotState();
  }

  function isOnline(): boolean {
    return bot !== undefined && bot.state !== 'closed' && bot.state !== 'idle';
  }

  async function observeMessage(value: unknown): Promise<{ accepted: boolean }> {
    const input = value as { sessionId?: unknown; message?: ControlObservedMessage } | null;
    const adapter = bot?.onebot;
    if (
      closed ||
      opened !== 'attach' ||
      bot?.state !== 'online' ||
      !adapter ||
      !input ||
      typeof input.sessionId !== 'number' ||
      input.sessionId !== bot.sessionId
    )
      return { accepted: false };

    const message = input.message;
    if (
      !message ||
      !isPositiveId(message.messageId) ||
      !isPositiveId(message.peer?.id) ||
      !isPositiveId(message.sender?.id) ||
      (message.scene !== 'private' && message.scene !== 'group') ||
      !Number.isSafeInteger(message.seq) ||
      message.seq < 0 ||
      !Number.isSafeInteger(message.time) ||
      message.time <= 0 ||
      !Array.isArray(message.elements) ||
      message.elements.length === 0 ||
      message.elements.some((element) => !element || typeof element.kind !== 'string')
    ) {
      throw new WeqBotError('CONTROL_PROTOCOL_ERROR', '本地消息字段不合法');
    }

    const key = `${input.sessionId}:${message.scene}:${message.peer.id}:${message.messageId}`;
    const previous = observedMessages.get(key);
    if (previous) return { accepted: await previous };
    // 成功后保留消息身份，覆盖控制请求超时后数据库订阅重新读取同一页的情况。
    const delivery = adapter.observeMessage({ ...message, self: { uin: options.uin } });
    observedMessages.set(key, delivery);
    let accepted = false;
    try {
      accepted = await delivery;
      if (accepted && observedMessages.size > 4096) {
        const oldest = observedMessages.keys().next();
        if (!oldest.done) observedMessages.delete(oldest.value);
      }
      return { accepted };
    } finally {
      if (!accepted) observedMessages.delete(key);
    }
  }

  async function handle(
    envelope: ControlEnvelope,
    reply: (envelope: ControlEnvelope) => void,
  ): Promise<void> {
    if (envelope.kind !== 'request') {
      log.warn('忽略非请求信封', { kind: envelope.kind });
      return;
    }

    try {
      switch (envelope.method) {
        case 'ping':
          reply(controlSuccess(envelope.id, { pid: process.pid, ts: Date.now() }));
          return;
        case 'status':
          reply(controlSuccess(envelope.id, status()));
          return;
        case 'login':
          reply(
            controlSuccess(
              envelope.id,
              await login(
                envelope.params as {
                  a1: string;
                  guid: string;
                  uid?: string;
                  device?: DeviceProfile;
                  qqDbPath?: string;
                },
              ),
            ),
          );
          return;
        case 'attach':
          reply(
            controlSuccess(
              envelope.id,
              await attachLogin(envelope.params as Parameters<typeof attachLogin>[0]),
            ),
          );
          return;
        case 'onebot.get':
          reply(controlSuccess(envelope.id, onebotState()));
          return;
        case 'onebot.set': {
          const params = envelope.params as { config?: ControlOneBotConfig | null } | undefined;
          reply(controlSuccess(envelope.id, await setOnebot(params?.config ?? null)));
          return;
        }
        case 'onebot.observeMessage':
          reply(controlSuccess(envelope.id, await observeMessage(envelope.params)));
          return;
        case 'shutdown': {
          const params = envelope.params as { reason?: string } | undefined;
          reply(controlSuccess(envelope.id, null));
          await shutdown(params?.reason);
          return;
        }
        default:
          reply(
            controlFailure(envelope.id, {
              code: 'CONTROL_PROTOCOL_ERROR',
              message: `未知方法 ${envelope.method}`,
            }),
          );
      }
    } catch (cause) {
      reply(controlFailure(envelope.id, failureOf(cause)));
    }
  }

  return {
    handle,
    subscribe(sink) {
      sinks.add(sink);
      return () => {
        sinks.delete(sink);
      };
    },
    status,
    close: (reason) => shutdown(reason ?? 'closed'),
    get closed() {
      return closed;
    },
  };
}

function isPositiveId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);
}

/** 会话状态机 → 控制通道的 5 个粗粒度状态。 */
export function controlState(state: string | undefined): ControlStatus['state'] {
  switch (state) {
    case 'online':
      return 'online';
    case 'degraded':
      return 'degraded';
    case 'closed':
      return 'closed';
    case 'idle':
    case undefined:
      return 'idle';
    default:
      // preflight / logging-in / logged-in / registering
      return 'connecting';
  }
}

function decodeA1(input: string): Uint8Array {
  const trimmed = input.trim();
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
    return new Uint8Array(Buffer.from(trimmed, 'hex'));
  }
  return new Uint8Array(Buffer.from(trimmed, 'base64'));
}

export function failureOf(cause: unknown): ControlFailure {
  if (cause instanceof WeqBotError) {
    return {
      code: cause.code,
      message: cause.message,
      ...(cause.detail.fields ? { details: cause.detail.fields } : {}),
    };
  }
  return {
    code: 'UNKNOWN',
    message: cause instanceof Error ? cause.message : String(cause),
  };
}
