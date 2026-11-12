/**
 * `createBot()` —— 门面层，也是 WeQ 嵌入时的唯一入口。
 *
 * 组装顺序是刻意固定的（每一步失败后的动作不同，见 `@weqbot/session` 的状态机）：
 *
 *   native 能力探测 → 预检 → 取 a1 → quickLogin → openOnline → 挂推送 → 在线
 *
 * 这一层**不 import 任何 `.node`**，也不 import `@weqbot/node`：宿主把 native 端口
 * 递进来。WeQ 传 `adaptNativeBinding(platform.native)`；独立进程传 slim 加载器的产物。
 */

import { createLogger, TypedEventBus, WeqBotError, type Logger } from '@weqbot/common';
import {
  inspectNative,
  ONLINE_TARGET_BASE,
  type NativePort,
  type OnlineSession,
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
}

export function createBot(options: CreateBotOptions): Bot {
  const { config, native, vault } = options;
  const log = options.logger ?? createLogger('bot', { level: config.log?.level ?? 'info' });
  const events = new TypedEventBus<BotEventMap>();
  const machine = new SessionStateMachine();
  const uin = config.account.uin;

  let session: OnlineSession | undefined;
  let protocol: ProtocolClient | undefined;

  machine.onChange((change) => {
    events.emit('state', { type: 'state', ...change });
  });

  const capabilities = inspectNative(native);

  /** 预检：能力 + 平台 + 凭据可用性。失败信息要能让用户知道去修什么。 */
  async function preflight(account: StoredAccount | undefined): Promise<void> {
    capabilities.requireAll(
      ['sendPacket', 'sendOidb', 'quickLogin', 'openOnline', 'pushSink'],
      'mode2 需要带 openOnline / pushSink 的构建（P2 起才有）',
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

  async function start(): Promise<void> {
    if (machine.state !== 'idle') {
      throw new WeqBotError('UNKNOWN', `bot 已经在 ${machine.state}，不能重复 start`);
    }

    machine.transition('preflight', '读取凭据');
    const account = await vault.get(uin);
    await preflight(account);
    const stored = account as StoredAccount;

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
    log.info('换票成功', { uin, uid: login.uid });

    machine.transition('logged-in', 'a2/d2 已就绪（仅内存）');

    machine.transition('registering', 'openOnline');
    session = await native.openOnline!({
      uin,
      a1: stored.a1,
      guid: stored.guid,
      device: stored.device,
      secure: {
        qua: stored.device.qua,
        secToken: (options.secToken ?? (() => generateSecToken()))(stored),
      },
      signer: {
        // TODO(P2)：wrapper.node 的路径由预检阶段按平台解析（QQ 安装路径 +
        // `resources/app/wrapper.node`），现在由宿主通过 config 或 native 自己解决。
        wrapperPath: null,
      },
    });

    if (session.handle < ONLINE_TARGET_BASE) {
      throw new WeqBotError('REGISTER_FAILED', `native 返回了非法句柄 ${session.handle}`);
    }
    if (!session.registered) {
      throw new WeqBotError('REGISTER_FAILED', 'openOnline 返回但未完成注册', {
        fields: { handle: session.handle },
      });
    }

    protocol = createProtocolClient({ native, target: session.handle });

    // TODO(P3)：推送帧 → protocol/push 解码 → BotEvent → events.emit。
    const offPush = await native.attachPushSink!(session.handle, (frame) => {
      events.emit('event', { type: 'heartbeat', at: frame.ts });
      log.debug('收到推送', { command: frame.command, seq: frame.seq, bytes: frame.body.length });
    });

    machine.transition('online', '已注册');
    events.emit('online', { type: 'online', uin, at: Date.now() });

    // TODO(P3)：把状态事件接上 —— kicked → offline('kicked') + 可选重登；
    // network → degraded → 退避后重走 logging-in。
    if (native.attachStatusSink) {
      await native.attachStatusSink(session.handle, (event) => {
        log.debug('会话状态', { kind: event.kind });
        if (event.kind === 'heartbeat') {
          events.emit('heartbeat', { type: 'heartbeat', at: event.ts, rttMs: event.rttMs });
        }
      });
    }
    void offPush;
  }

  async function stop(reason: OfflineReason = 'closed'): Promise<void> {
    if (machine.isTerminal) return;
    try {
      if (session && native.closeOnline) await native.closeOnline(session.handle, reason);
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
  };
}

/** 供 CLI / 测试使用的最小健康检查（不启动任何连接）。 */
export function describeBot(options: Pick<CreateBotOptions, 'config' | 'native'>): string {
  const capabilities = inspectNative(options.native);
  return [
    `account=${options.config.account.uin}`,
    `capabilities=${capabilities.list().join(',') || '(none)'}`,
    `missing=${capabilities.missing(['sendPacket', 'quickLogin', 'openOnline', 'pushSink']).join(',') || '(none)'}`,
  ].join(' ');
}
