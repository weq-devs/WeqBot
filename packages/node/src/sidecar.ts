/**
 * `--sidecar`：desktop 托管的独立进程。
 *
 * 传输是 NDJSON over stdio（契约与编解码在 `@weqbot/control`）。生命周期由宿主
 * 掌握：`login` 交付凭据后开始上线，`shutdown` 或 **stdin 关闭**（宿主退出 /
 * 崩溃）都让 sidecar 自己退出 —— 后者是 V10 的验收点，不依赖父进程的 signal。
 *
 * 凭据只从控制通道进来，不读自己的 vault 之外的任何文件；a1 落 `FileCredentialVault`
 * 后立刻从内存清掉（`login` 的 params 不在闭包里保留）。
 */

import { createLogger, WeqBotError, type Logger } from '@weqbot/common';
import { createBot, type Bot, type BotConfig } from '@weqbot/bot';
import {
  ControlLineDecoder,
  CONTROL_EVENTS,
  controlEvent,
  controlFailure,
  controlSuccess,
  encodeEnvelope,
  type ControlEnvelope,
  type ControlStatus,
  type ControlFailure,
} from '@weqbot/control';
import type { CredentialVault, StoredAccount } from '@weqbot/session';
import type { DeviceProfile, NativePort } from '@weqbot/wire';

export interface SidecarOptions {
  /** 账号由 spawn 时决定，控制通道拿不到第二个账号。 */
  uin: string;
  native: NativePort;
  vault: CredentialVault;
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  logger?: Logger;
  /** 注入点：测试用假 Bot，生产用 createBot。 */
  botFactory?: (options: Parameters<typeof createBot>[0]) => Bot;
  /** 退出回调（默认 `process.exit(0)`）；测试里替换掉。 */
  onExit?: (code: number) => void;
}

export interface SidecarHandle {
  /** 主动关闭（测试 / 宿主显式调用）。 */
  close(): Promise<void>;
}

export function runSidecar(options: SidecarOptions): SidecarHandle {
  const log = options.logger ?? createLogger('sidecar');
  const botFactory = options.botFactory ?? createBot;
  const onExit = options.onExit ?? ((code: number) => process.exit(code));
  const decoder = new ControlLineDecoder();

  let bot: Bot | undefined;
  let device: DeviceProfile | null = null;
  let closed = false;
  let starting: Promise<ControlStatus> | undefined;
  let offs: (() => void)[] = [];

  const write = (envelope: ControlEnvelope): void => {
    options.stdout.write(encodeEnvelope(envelope));
  };

  const status = (): ControlStatus => ({
    uin: options.uin,
    state: controlState(bot?.state),
    sessionId: bot?.sessionId ?? null,
    lastEventAt: lastEventAt,
    device,
  });
  let lastEventAt: number | null = null;

  function attachBot(next: Bot): void {
    offs.push(
      next.events.on('state', (change) => {
        lastEventAt = change.at;
        write(controlEvent(CONTROL_EVENTS.state, change));
      }),
      next.events.on('heartbeat', (event) => {
        lastEventAt = event.at;
        write(controlEvent(CONTROL_EVENTS.heartbeat, event));
      }),
      next.events.on('event', (event) => {
        lastEventAt = Date.now();
        write(controlEvent(CONTROL_EVENTS.onebot, event));
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
    write(controlEvent(CONTROL_EVENTS.bye, { reason: reason ?? 'shutdown' }));
    onExit(0);
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
        'sidecar 需要 device 档案（appId/subAppId/qua/clientVersion/os），否则设备指纹会漂移',
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

    const qqDbPath = params.qqDbPath ?? process.env.WEQBOT_QQ_DB;
    const config: BotConfig = {
      account: { uin: options.uin },
      native: {},
      ...(qqDbPath ? { qq: { dbPath: qqDbPath } } : {}),
      log: { level: 'info' },
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

  async function dispatch(envelope: ControlEnvelope): Promise<void> {
    if (envelope.kind !== 'request') {
      log.warn('忽略非请求信封', { kind: envelope.kind });
      return;
    }

    try {
      switch (envelope.method) {
        case 'ping':
          write(controlSuccess(envelope.id, { pid: process.pid, ts: Date.now() }));
          return;
        case 'status':
          write(controlSuccess(envelope.id, status()));
          return;
        case 'login':
          write(
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
          write(controlSuccess(envelope.id, null));
          await shutdown(params?.reason);
          return;
        }
        default:
          write(
            controlFailure(envelope.id, {
              code: 'CONTROL_PROTOCOL_ERROR',
              message: `未知方法 ${envelope.method}`,
            }),
          );
      }
    } catch (cause) {
      write(controlFailure(envelope.id, failureOf(cause)));
    }
  }

  options.stdin.on('data', (chunk: Uint8Array) => {
    let envelopes: ControlEnvelope[];
    try {
      envelopes = decoder.push(chunk);
    } catch (cause) {
      write(controlFailure(0, failureOf(cause)));
      return;
    }
    for (const envelope of envelopes) void dispatch(envelope);
  });

  // 宿主退出 / 崩溃：stdin 关闭即自杀（V10）。
  const onEnd = (): void => {
    log.info('stdin 已关闭，sidecar 自行退出');
    void shutdown('parent-gone');
  };
  options.stdin.on('end', onEnd);
  options.stdin.on('close', onEnd);

  return {
    async close() {
      await shutdown('closed');
    },
  };
}

/** 会话状态机 → 控制通道的 5 个粗粒度状态。 */
function controlState(state: string | undefined): ControlStatus['state'] {
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

function failureOf(cause: unknown): ControlFailure {
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
