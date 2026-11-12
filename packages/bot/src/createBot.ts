/**
 * `createBot()` —— 门面层，也是 WeQ 嵌入时的唯一入口。
 *
 * 组装顺序是刻意固定的（每一步失败后的动作不同，见 `@weqbot/session` 的状态机）：
 *
 *   native 能力探测 → 预检 → 取 a1 → quickLogin → openSession(mode 2) → 挂 sink → 在线
 *
 * 本层只和 `sessionId` 打交道，**不接触 pid**。这一层也**不 import 任何 `.node`**，
 * 不 import `@weqbot/node`：宿主把 native 端口递进来。WeQ 传
 * `adaptNativeBinding(platform.native.ntHelper)`；独立进程传 slim 加载器的产物。
 */

import { bytesEqual, createLogger, TypedEventBus, WeqBotError, type Logger } from '@weqbot/common';
import {
  inspectNative,
  type DeviceProfile,
  type NativePort,
  type OpenedSession,
  type SsoSessionConfig,
} from '@weqbot/wire';
import type {
  BotEventMap,
  CredentialVault,
  OfflineReason,
  SessionState,
  StoredAccount,
} from '@weqbot/session';
import { SessionStateMachine } from '@weqbot/session';
import type { ProtocolClient } from '@weqbot/protocol';
import { createProtocolClient } from '@weqbot/protocol';
import type { BotConfig } from './config';
import { generateSecToken } from './sec-token';

export interface CreateBotOptions {
  config: BotConfig;
  /** 宿主注入的原生端口。 */
  native: NativePort;
  vault: CredentialVault;
  logger?: Logger;
  /** 覆盖 secToken 生成（测试 / 逆向实验用）。 */
  secToken?: (account: StoredAccount) => string;
}

export interface Bot {
  readonly uin: string;
  readonly state: SessionState;
  readonly events: TypedEventBus<BotEventMap>;
  /** 上线后可用的协议客户端；未上线时为 undefined。 */
  readonly protocol: ProtocolClient | undefined;
  start(): Promise<void>;
  stop(reason?: OfflineReason): Promise<void>;
  /** 立即原地轮换 `SecToken`（不重连、不重新登录）。 */
  refreshSecToken(): Promise<void>;
}

export function createBot(options: CreateBotOptions): Bot {
  const { config, native, vault } = options;
  const log = options.logger ?? createLogger('bot', { level: config.log?.level ?? 'info' });
  const events = new TypedEventBus<BotEventMap>();
  const machine = new SessionStateMachine();
  const uin = config.account.uin;

  let session: OpenedSession | undefined;
  let protocol: ProtocolClient | undefined;
  let offPush: (() => void) | undefined;
  let offStatus: (() => void) | undefined;
  let storedAccount: StoredAccount | undefined;
  let tokenTimer: ReturnType<typeof setTimeout> | undefined;

  machine.onChange((change) => {
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

  function makeSecToken(account: StoredAccount): string {
    return (options.secToken ?? (() => generateSecToken()))(account);
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
    if (rotateMs <= 0) return;
    if (!native.setSecToken) {
      log.warn('native 缺少 setSecToken，长跑将无法轮换 SecToken', { uin });
      return;
    }

    tokenTimer = setTimeout(() => {
      void refreshSecToken()
        .catch((cause) => log.warn('SecToken 轮换失败', { uin, cause }))
        .finally(scheduleTokenRotation);
    }, rotateMs);
    tokenTimer.unref?.();
  }

  async function start(): Promise<void> {
    if (machine.state !== 'idle') {
      throw new WeqBotError('UNKNOWN', `bot 已经在 ${machine.state}，不能重复 start`);
    }

    machine.transition('preflight', '读取凭据');
    const account = await vault.get(uin);
    await preflight(account);
    const stored = account as StoredAccount;
    storedAccount = stored;

    machine.transition('logging-in', 'quickLogin(a1)');
    const login = await native.quickLogin!({
      uin,
      a1: stored.a1,
      guid: stored.guid,
      appId: stored.device.appId,
      subAppId: stored.device.subAppId,
      qua: stored.device.qua,
      clientVersion: stored.device.clientVersion,
    });

    // native 的 QuickLoginResult 不保证回传 uid；vault 里的账号记录是权威来源。
    const uid = login.uid || stored.uid;
    if (!uid) {
      throw new WeqBotError('LOGIN_FAILED', `${uin} 既没有登录返回的 uid，也没有 vault 里的 uid`, {
        fields: { uin },
      });
    }
    log.info('换票成功', { uin, uid });

    // 服务端可能在登录过程中轮换 a1；拿到就写回，避免下次还用旧值。
    if (login.a1 && login.a1.length > 0 && !bytesEqual(login.a1, stored.a1)) {
      try {
        await vault.put({ ...stored, a1: login.a1 });
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

    // wrapper 路径由宿主配置，或由 native 的**进程层**探测接口给出；
    // SSO 层只消费路径，不做平台探测。
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

    machine.transition('registering', 'openSession(mode=2)');
    session = await native.openSession!({
      session: sessionConfig,
      mode: 2,
      signer: { wrapperPath },
      device,
    });

    if (!Number.isInteger(session.sessionId) || session.sessionId < 1) {
      throw new WeqBotError('REGISTER_FAILED', `native 返回了非法会话 ID ${session.sessionId}`);
    }
    if (!session.registered || !session.synced || session.state !== 'online') {
      throw new WeqBotError('REGISTER_FAILED', 'openSession 返回但尚未完成注册 / 首屏同步', {
        fields: {
          sessionId: session.sessionId,
          registered: session.registered,
          synced: session.synced,
          state: session.state,
        },
      });
    }

    protocol = createProtocolClient({ native, sessionId: session.sessionId });

    // TODO(P3)：推送帧 → protocol/push 解码 → BotEvent → events.emit。
    offPush = await native.attachPushSink!(
      session.sessionId,
      (frame) => {
        log.debug('收到推送', {
          command: frame.command,
          seq: frame.seq,
          bytes: frame.body.length,
        });
      },
      (error) => {
        events.emit('event', {
          type: 'error',
          error: new WeqBotError('UNKNOWN', '推送通道错误', { cause: error }),
          at: Date.now(),
        });
      },
    );

    machine.transition('online', '已注册且首屏同步完成');
    events.emit('online', { type: 'online', uin, at: Date.now() });

    // TODO(P3)：把状态事件接全 —— kicked → offline('kicked')；network →
    // degraded → 退避后重走 logging-in。现在只转发心跳。
    if (native.attachStatusSink) {
      offStatus = await native.attachStatusSink(session.sessionId, (event) => {
        log.debug('会话状态', { kind: event.kind });
        if (event.kind === 'heartbeat') {
          events.emit('heartbeat', { type: 'heartbeat', at: event.ts, rttMs: event.rttMs });
        }
      });
    }

    scheduleTokenRotation();
  }

  async function stop(reason: OfflineReason = 'closed'): Promise<void> {
    if (machine.isTerminal) return;
    if (tokenTimer) {
      clearTimeout(tokenTimer);
      tokenTimer = undefined;
    }
    offPush?.();
    offPush = undefined;
    offStatus?.();
    offStatus = undefined;
    try {
      if (session && native.closeSession) await native.closeSession(session.sessionId, reason);
    } finally {
      session = undefined;
      protocol = undefined;
      machine.forceClose(reason);
      events.emit('offline', { type: 'offline', reason, at: Date.now() });
      events.clear();
    }
  }

  return {
    uin,
    get state() {
      return machine.state;
    },
    events,
    get protocol() {
      return protocol;
    },
    start,
    stop,
    refreshSecToken,
  };
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
