/**
 * `--serve`：常驻 daemon（OneBot 与宿主生命周期解耦的关键）。
 *
 * 与 `--sidecar` 的区别只有生命周期和传输：
 *
 * - 传输是 unix socket / named pipe（`@weqbot/control` 的 `listenControlSocket`），
 *   可以同时接多个客户端；
 * - **客户端断开不退出**。WeQ / Electron 关掉之后 QQ 会话继续挂着，OneBot 的
 *   HTTP / WS 端口也继续对外服务；只有显式 `shutdown` 或进程信号才结束。
 *
 * 账号由启动参数固定（一个 daemon 一个账号），凭据仍只从控制通道的 `login` 进来：
 * daemon 自己不碰 vault 之外的文件，也不在磁盘上留密码。
 */

import { createLogger, type Logger } from '@weqbot/common';
import type { BotConfig } from '@weqbot/bot';
import {
  defaultControlSocketPath,
  listenControlSocket,
  type ControlServerPeer,
  type ControlSocketServer,
} from '@weqbot/control';
import type { CredentialVault } from '@weqbot/session';
import type { NativePort } from '@weqbot/wire';
import { createControlHost, type ControlHostOptions } from './control-host';

export interface DaemonOptions {
  /** 一个 daemon 一个账号。 */
  uin: string;
  native: NativePort;
  vault: CredentialVault;
  logger?: Logger;
  config?: Omit<BotConfig, 'account'>;
  botFactory?: ControlHostOptions['botFactory'];
  /** 默认 `defaultControlSocketPath(uin)`。 */
  socketPath?: string;
  /** daemon 真正退出时调用（默认 `process.exit(0)`）；测试里替换。 */
  onExit?: (code: number) => void;
}

export interface DaemonHandle {
  readonly socketPath: string;
  /** 下线 + 广播 `bye` + 关 socket + onExit（幂等）。 */
  close(reason?: string): Promise<void>;
  /** 当前连着的客户端数（诊断用）。 */
  clients(): number;
  /** 控制会话本身（测试 / 嵌入式宿主可直接用，不经过 socket）。 */
  readonly host: ReturnType<typeof createControlHost>;
}

export async function runDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  const log = options.logger ?? createLogger('daemon');
  const onExit = options.onExit ?? ((code: number) => process.exit(code));
  const socketPath = options.socketPath ?? defaultControlSocketPath(options.uin);
  const peers = new Set<ControlServerPeer>();

  let server: ControlSocketServer | undefined;
  let closing: Promise<void> | undefined;

  const host = createControlHost({
    uin: options.uin,
    native: options.native,
    vault: options.vault,
    logger: log,
    ...(options.config ? { config: options.config } : {}),
    ...(options.botFactory ? { botFactory: options.botFactory } : {}),
    // `bye` 已经广播给所有连接，这里只负责真的收摊。
    onShutdown: (reason) => {
      void finish(reason);
    },
  });

  async function finish(reason: string): Promise<void> {
    if (!closing) {
      closing = (async () => {
        log.info('daemon 下线', { reason, uin: options.uin });
        // host.close 在这里已经是幂等的空操作：shutdown 走的就是它。
        await host.close(reason);
        await server?.close();
        onExit(0);
      })();
    }
    await closing;
  }

  server = await listenControlSocket({
    path: socketPath,
    logger: log,
    onPeer(peer) {
      peers.add(peer);
      peer.onRequest((envelope) => {
        void host.handle(envelope, (response) => peer.send(response));
      });
      const unsubscribe = host.subscribe((event) => peer.send(event));
      peer.onClose(() => {
        unsubscribe();
        peers.delete(peer);
        // 客户端走了，但 daemon 不退出 —— 这正是与 sidecar 的分水岭。
        log.info('控制通道客户端断开', { remaining: peers.size });
      });
    },
  });

  log.info('daemon 已就绪，等待控制通道连接', {
    uin: options.uin,
    socket: server.path,
    socketPath,
  });

  return {
    socketPath: server.path,
    close: (reason) => finish(reason ?? 'closed'),
    clients: () => peers.size,
    host,
  };
}
