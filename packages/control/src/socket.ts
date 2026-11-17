/**
 * 控制通道的 socket 传输（unix socket / Windows named pipe）。
 *
 * 与 stdio 的区别只有两处，但都是关键：
 *
 * 1. **生命周期解耦**：stdio 的 sidecar 在 stdin 关闭时必须自杀（宿主没了）；socket
 *    的 daemon 恰恰相反 —— 客户端断开只是「暂时没人看」，QQ 会话要继续挂着。
 * 2. **多客户端**：socket 可以同时接 WeQ 控制台和 `weqbot --status` 之类的短命探针，
 *    所以服务端按连接分发，事件由调用方广播。
 *
 * 分帧仍然是 `@weqbot/control` 的 NDJSON（`ControlLineDecoder`），一行一个信封。
 * 这里只做「流 ↔ 信封」和「id ↔ 待应答」两件事，不引入 RPC 框架。
 */

import { chmodSync, mkdirSync, unlinkSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ControlLineDecoder, encodeEnvelope } from './codec';
import {
  controlFailure,
  controlRequest,
  type ControlEnvelope,
  type ControlMethod,
  type ControlParams,
  type ControlResult,
} from './protocol';

/** 单次请求的默认等待上限。`login` 要建连 + 注册，比 ping 慢得多。 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

/**
 * 默认 socket 路径。
 *
 * 放在 `$XDG_RUNTIME_DIR`（登录即清空）而不是家目录：socket 是「这次登录的进程」的
 * 附庸，重启后残留的路径文件只会让下一次启动多踩一次 EADDRINUSE。没有 XDG 的环境
 * 退回 `~/.weqbot/run`，`WEQBOT_SOCKET_DIR` 可整体覆盖（测试 / 多实例）。
 */
export function defaultControlSocketPath(uin: string): string {
  const id = socketName(uin);
  if (process.platform === 'win32') return `\\\\.\\pipe\\${id}`;
  const base = process.env.WEQBOT_SOCKET_DIR?.trim();
  const dir = base || join(runtimeDir(), 'weqbot');
  return join(dir, `${id}.sock`);
}

function socketName(uin: string): string {
  return /^[1-9]\d*$/.test(uin) ? `weqbot-${uin}` : 'weqbot';
}

function runtimeDir(): string {
  const xdg = process.env.XDG_RUNTIME_DIR?.trim();
  return xdg || join(homedir(), '.weqbot', 'run');
}

/** 对端回了一个 `ok: false`。`code` 通常是 `WeqBotErrorCode`，但不强绑版本。 */
export class ControlRemoteError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ControlRemoteError';
  }
}

export interface ControlPeer {
  /** 发请求并等应答；对端回了失败则 reject `ControlRemoteError`。 */
  request<M extends ControlMethod>(
    method: M,
    params: ControlParams<M>,
    options?: { timeoutMs?: number },
  ): Promise<ControlResult<M>>;
  /** 订阅事件（state / heartbeat / onebot / bye）；返回退订函数。 */
  on(handler: (envelope: ControlEnvelope) => void): () => void;
  close(): void;
  readonly closed: boolean;
}

export interface ConnectControlOptions {
  /** 默认 `defaultControlSocketPath(uin)`；直连时自己给。 */
  path: string;
  connectTimeoutMs?: number;
}

/** 连上 daemon。连接失败（没起 / 路径不对）直接 reject，不重试。 */
export function connectControlSocket(options: ConnectControlOptions): Promise<ControlPeer> {
  return new Promise((resolve, reject) => {
    const socket = connect(options.path);
    const decoder = new ControlLineDecoder();
    const handlers = new Set<(envelope: ControlEnvelope) => void>();
    const pending = new Map<
      number,
      { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
    >();
    let nextId = 1;
    let closed = false;

    const failAll = (error: Error): void => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }
      pending.clear();
    };

    const settle = (envelope: ControlEnvelope): void => {
      if (envelope.kind !== 'response') {
        for (const handler of handlers) handler(envelope);
        return;
      }
      const entry = pending.get(envelope.id);
      if (!entry) return;
      pending.delete(envelope.id);
      clearTimeout(entry.timer);
      if (envelope.ok) entry.resolve(envelope.result);
      else {
        const failure = envelope.error;
        entry.reject(
          new ControlRemoteError(
            failure?.code ?? 'UNKNOWN',
            failure?.message ?? '控制通道请求失败',
            failure?.details,
          ),
        );
      }
    };

    socket.on('data', (chunk: Uint8Array) => {
      try {
        for (const envelope of decoder.push(chunk)) settle(envelope);
      } catch (cause) {
        // 协议错就断开：继续读下去会把这一行的错位喂给后面的请求。
        socket.destroy();
        failAll(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });

    const onGone = (): void => {
      if (closed) return;
      closed = true;
      failAll(new Error('控制通道已断开'));
    };
    socket.on('close', onGone);
    socket.on('error', (cause) => {
      failAll(cause);
      onGone();
    });

    socket.once('connect', () => {
      socket.setNoDelay(true);
      resolve({
        request(method, params, requestOptions) {
          if (closed) return Promise.reject(new Error('控制通道已断开'));
          const id = nextId++;
          const timeoutMs = requestOptions?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
          return new Promise((resolveRequest, rejectRequest) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              rejectRequest(new Error(`控制通道请求超时（${method}，${timeoutMs}ms）`));
            }, timeoutMs);
            pending.set(id, {
              resolve: (value) => resolveRequest(value as ControlResult<typeof method>),
              reject: rejectRequest,
              timer,
            });
            socket.write(encodeEnvelope(controlRequest(id, method, params)));
          }) as Promise<ControlResult<typeof method>>;
        },
        on(handler) {
          handlers.add(handler);
          return () => {
            handlers.delete(handler);
          };
        },
        close() {
          if (closed) return;
          closed = true;
          socket.destroy();
        },
        get closed() {
          return closed;
        },
      });
    });

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`连接控制通道超时：${options.path}`));
    }, options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
    socket.once('connect', () => clearTimeout(timer));
    socket.once('error', () => clearTimeout(timer));
  });
}

/** 服务端眼里的一条连接。 */
export interface ControlServerPeer {
  readonly remote: string;
  send(envelope: ControlEnvelope): void;
  /** 收到 request 时回调（response / event 由传输层自己拒掉）。 */
  onRequest(handler: (envelope: ControlEnvelope) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

export interface ControlSocketServerOptions {
  path: string;
  onPeer(peer: ControlServerPeer): void;
  logger?: { warn(message: string, meta?: Record<string, unknown>): void };
}

export interface ControlSocketServer {
  readonly path: string;
  close(): Promise<void>;
}

type ListenError = NodeJS.ErrnoException;

/**
 * 监听 socket。
 *
 * 残留路径文件的处理是**探测**而不是盲删：先 connect 一次，被拒（ECONNREFUSED /
 * ENOENT）才认定是上次崩溃留下的尸体；连得上就说明有活着的 daemon，直接报错 ——
 * 盲删会把两个 daemon 都挂到同一个 uin 上。
 */
export async function listenControlSocket(
  options: ControlSocketServerOptions,
): Promise<ControlSocketServer> {
  const unix = process.platform !== 'win32';
  if (unix) {
    mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
  }

  let server: Server;
  try {
    server = await listenOnce(options);
  } catch (cause) {
    const error = cause as ListenError;
    if (error.code !== 'EADDRINUSE' || !unix || !(await isStale(options.path))) throw cause;
    unlinkSync(options.path);
    server = await listenOnce(options);
  }

  // unix socket 的文件权限就是访问控制：默认 umask 下别的用户也能连。
  if (unix) chmodSync(options.path, 0o600);

  const sockets = new Set<Socket>();

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    const decoder = new ControlLineDecoder();
    const requestHandlers: ((envelope: ControlEnvelope) => void)[] = [];
    const closeHandlers: (() => void)[] = [];
    let gone = false;

    const peer: ControlServerPeer = {
      remote: `${socket.remoteAddress ?? 'local'}:${socket.remotePort ?? 0}`,
      send(envelope) {
        if (gone || socket.destroyed) return;
        socket.write(encodeEnvelope(envelope));
      },
      onRequest(handler) {
        requestHandlers.push(handler);
      },
      onClose(handler) {
        closeHandlers.push(handler);
      },
      close() {
        socket.end();
      },
    };
    // 每条连接只通知一次：调用方在这里挂 sink / 处理请求。
    options.onPeer(peer);

    socket.on('data', (chunk: Uint8Array) => {
      let envelopes: ControlEnvelope[];
      try {
        envelopes = decoder.push(chunk);
      } catch (cause) {
        // 单行超限 / 非 JSON：告诉对端然后断开，不让污染的行继续流。
        peer.send(
          controlFailure(0, {
            code: 'CONTROL_PROTOCOL_ERROR',
            message: cause instanceof Error ? cause.message : String(cause),
          }),
        );
        socket.destroy();
        return;
      }
      for (const envelope of envelopes) {
        if (envelope.kind !== 'request') {
          // 客户端不该发 response / 不该伪造事件。
          peer.send(
            controlFailure(envelope.kind === 'response' ? envelope.id : 0, {
              code: 'CONTROL_PROTOCOL_ERROR',
              message: '只接受 request 信封',
            }),
          );
          continue;
        }
        for (const handler of requestHandlers) handler(envelope);
      }
    });

    const onGone = (): void => {
      if (gone) return;
      gone = true;
      sockets.delete(socket);
      for (const handler of closeHandlers) handler();
    };
    socket.on('close', onGone);
    socket.on('error', (cause) => {
      // 客户端先关是常态：广播撞上已断开的连接必然 EPIPE / ECONNRESET，
      // 那不是「出错」，不要每条都打成告警。
      const code = (cause as NodeJS.ErrnoException).code;
      if (code !== 'EPIPE' && code !== 'ECONNRESET') {
        options.logger?.warn('控制通道连接出错', { remote: peer.remote, cause });
      }
      onGone();
    });
  });

  return {
    path: options.path,
    async close() {
      // 先把已排队的帧刷出去（`bye` 就在里面）再断开，别让宿主收不到「我下线了」。
      await Promise.all(
        [...sockets].map(
          (socket) =>
            new Promise<void>((resolve) => {
              const done = (): void => resolve();
              const force = setTimeout(() => {
                socket.destroy();
                resolve();
              }, 500);
              force.unref();
              socket.once('close', () => {
                clearTimeout(force);
                done();
              });
              socket.end();
            }),
        ),
      );
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (unix) {
        try {
          unlinkSync(options.path);
        } catch {
          // 已经没了。
        }
      }
    },
  };
}

function listenOnce(options: ControlSocketServerOptions): Promise<Server> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.path, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

function isStale(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(path);
    const done = (stale: boolean): void => {
      probe.destroy();
      resolve(stale);
    };
    probe.once('connect', () => done(false));
    probe.once('error', () => done(true));
  });
}
