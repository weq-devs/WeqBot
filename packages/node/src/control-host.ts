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
import { createBot, type Bot, type BotConfig } from '@weqbot/bot';
import {
  CONTROL_EVENTS,
  controlEvent,
  controlFailure,
  controlSuccess,
  type ControlEnvelope,
  type ControlFailure,
  type ControlStatus,
} from '@weqbot/control';
import type { CredentialVault, StoredAccount } from '@weqbot/session';
import type { DeviceProfile, NativePort } from '@weqbot/wire';

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

  const broadcast = (envelope: ControlEnvelope): void => {
    for (const sink of sinks) sink(envelope);
  };

  const status = (): ControlStatus => ({
    uin: options.uin,
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
    const config: BotConfig = {
      // 启动参数打底（onebot / session / secToken / native.wrapperPath），
      // 再被本次 login 的 qqDbPath 覆盖 —— 凭据永远不在这里。
      ...options.config,
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

  function isOnline(): boolean {
    return bot !== undefined && bot.state !== 'closed' && bot.state !== 'idle';
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
