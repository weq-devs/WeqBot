/**
 * `createOneBotAdapter`：把 action / 事件 / 网络三层组装起来。
 *
 * 生命周期（与 SnowLuma 的 instance 同思路）：
 *
 *   start()  → 注册 action（按后端能力）→ 起网络 → 下发 lifecycle meta_event
 *   事件到达 → convertEvent → 按各连接的 messageFormat 推给所有 Event/Universal
 *   stop()   → 先退订事件，再关网络（不留半写事件）
 *
 * **多服务**：每类网络都是数组，配置里挂几个就起几个。这是 OneBot v11 的常规
 * 用法（一个 HTTP + 一个正向 WS + 多个反向 WS 同时存在），也是用户明确要求的。
 */

import { createLogger, WeqBotError, type Logger } from '@weqbot/common';
import type { BotEvent, BotEventMap } from '@weqbot/session';

type BotEventMapEvent<K extends keyof BotEventMap> = BotEventMap[K];
import { ActionRegistry, type ActionContext, type ActionDoc } from './action-registry';
import { registerActions } from './actions';
import { describeBackend, type OneBotBackend, type RecallTarget } from './backend';
import { convertEvent, heartbeatMetaEvent, lifecycleMetaEvent } from './event-converter';
import { MessageIdMap } from './message-id';
import { MessageStore } from './message-store';
import type { JsonObject, JsonValue, MessageFormat, OneBotConfig } from './types';
import { HttpClientAdapter } from './network/http-client';
import { HttpServerAdapter } from './network/http-server';
import type { NetworkSnapshot } from './network';
import { WsClientAdapter } from './network/ws-client';
import { WsServerAdapter } from './network/ws-server';

/** 网络适配器的最小公共面。 */
interface NetworkAdapter {
  broadcast(event: JsonObject): void;
  stop(): Promise<void>;
  /** `report_self_message`：false 时不推自己发出的消息。 */
  readonly reportSelfMessage: boolean;
  /** 观测快照；老适配器可能没有，调用方按可选处理。 */
  snapshot?(): NetworkSnapshot;
}

export interface ActionDispatchOptions {
  echo?: unknown;
  /** 适配器注入的观测钩子（网络层不需要知道）。 */
  onActionCall?(entry: {
    ts: number;
    action: string;
    params: JsonObject;
    retcode: number;
    status: 'ok' | 'failed';
    latencyMs: number;
    transport: 'ws' | 'http' | 'webui';
    client: string;
  }): void;
  /** 调用方的传输类型（日志 / 统计用）；`call()` 内部固定传 `webui`。 */
  transport?: 'ws' | 'http' | 'webui';
  /** 客户端标识（连接名 / 远端地址）。 */
  client?: string;
  /**
   * 调用观测钩子（WebUI 的 action 流水）。
   *
   * 放在 dispatch 上而不是网络层：WebUI 调试页也走同一个 `dispatch`，两处埋点
   * 会漂移。钩子同步返回即可，不阻塞响应。
   */
  observer?(entry: {
    ts: number;
    action: string;
    params: JsonObject;
    retcode: number;
    status: 'ok' | 'failed';
    latencyMs: number;
    transport: 'ws' | 'http' | 'webui';
    client: string;
  }): void;
}

/** 网络层拿到的分发函数：解析好的 action 名 + 参数 → OneBot 响应。 */
export type ActionDispatcher = (
  action: string,
  params: JsonObject,
  options: ActionDispatchOptions,
) => Promise<unknown>;

export interface CreateOneBotAdapterOptions {
  config: OneBotConfig;
  backend: OneBotBackend;
  selfId: number;
  /**
   * 事件源。只要求一个 `on('event', …)` —— `createBot()` 返回的 `Bot`
   * 天然满足，但 onebot 不依赖 `@weqbot/bot`（分层：bot → onebot）。
   */
  events: {
    on(event: 'event', listener: (event: BotEvent) => void): () => void;
    on(event: 'message', listener: (message: BotEventMapEvent<'message'>) => void): () => void;
    on(event: 'notice', listener: (notice: BotEventMapEvent<'notice'>) => void): () => void;
  };
  logger?: Logger;
  /** 心跳间隔（ms）；0 = 关。只影响 meta_event，与 SSO 心跳无关。 */
  heartbeatMs?: number;
  /** 覆盖 message_id 分配（测试用）。 */
  messageIds?: MessageIdMap;
  /** 覆盖消息缓存（测试用）。 */
  store?: MessageStore;
  /**
   * 入站图片 / 表情的下载 URL 解析（可选）。
   *
   * 不解码 wire 这里只拿得到 `fileToken` / `storeId`，`pic` segment 的 `url`
   * 会退化成空串。宿主（`@weqbot/bot`）用 `FetchDownloadRkeys` + CDN 拼接补上。
   * 抛错不影响事件本身：只要返回值不是字符串就当没解析出来。
   */
  imageUrlResolver?: (
    element: Record<string, unknown>,
    isGroup: boolean,
  ) => Promise<string> | string;
  /** 入站语音 / 视频 / 文件的下载 URL 解析（可选），语义同 {@link imageUrlResolver}。 */
  mediaUrlResolver?: (
    element: Record<string, unknown>,
    isGroup: boolean,
  ) => Promise<string> | string;
  /**
   * action 调用观测钩子（WebUI 的调试页 / 日志页）。
   *
   * 每条调用结束时回调一次，**包括** 1404（那说明客户端在调一个不存在的 action，
   * 恰恰是需要看的）。不阻塞响应。
   */
  onActionCall?(entry: {
    ts: number;
    action: string;
    params: JsonObject;
    retcode: number;
    status: 'ok' | 'failed';
    latencyMs: number;
    transport: 'ws' | 'http' | 'webui';
    client: string;
  }): void;
}

export interface OneBotAdapter {
  readonly port: number | undefined;
  /** 当前注册成功的 action 名。 */
  actions(): string[];
  /** 被跳过（后端没实现 / 敏感能力）的 action 名。 */
  skipped(): string[];
  /** 已注册 action 的文档元数据（含 `group` / `write`），WebUI 调试页分组用。 */
  describe(): ActionDoc[];
  /**
   * 各网络适配器的运行快照（WebUI 总览 / 网络页）。
   *
   * 只读观测，不参与分发；顺序与配置里声明的顺序一致。
   */
  networks(): NetworkSnapshot[];
  /**
   * 直接从进程内分发一次 action（不经 OneBot 网络）。
   *
   * WebUI 调试页用。走的是同一个注册表，所以敏感能力 / 未注册能力照样 1404。
   */
  call(action: string, params: JsonObject): Promise<unknown>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createOneBotAdapter(options: CreateOneBotAdapterOptions): OneBotAdapter {
  const log = options.logger ?? createLogger('onebot');
  const registry = new ActionRegistry();
  const messageIds = options.messageIds ?? new MessageIdMap();
  const store = options.store ?? new MessageStore();
  const networks: NetworkAdapter[] = [];
  let starting: Promise<void> | undefined;
  let messageIdSeed = 1_000_000;
  let started = false;
  /** 适配器启动时刻；`get_status.time` 是「运行秒数」。 */
  let startedAt = Date.now();
  let stopHeartbeat: (() => void) | undefined;
  let unsubscribers: Array<() => void> = [];
  let registered: string[] = [];
  let skipped: string[] = [];

  /** 发送类 action 的 message_id 分配（与收到的消息共用一张表）。 */
  function internSentMessageId(params: {
    isGroup: boolean;
    targetId: number;
    sequence: number;
    clientSequence: number;
    random: number;
    timestamp: number;
  }): number {
    const id = messageIdSeed++;
    if (messageIdSeed >= 0x7fffffff) messageIdSeed = 1_000_000;
    store.put(id, {
      meta: {
        isGroup: params.isGroup,
        targetId: params.targetId,
        sequence: params.sequence,
        // 私聊发送回执里的 sequence 就是服务端会话序号，历史窗口也用它。
        ...(params.isGroup ? {} : { ntSequence: params.sequence }),
        sequenceAuthoritative: true,
        eventName: params.isGroup ? 'group' : 'private',
        clientSequence: params.clientSequence,
        random: params.random,
        timestamp: params.timestamp,
      },
      event: {},
    });
    return id;
  }

  /** 历史 / 转发里的一条消息：分配 message_id + 缓存快照（有界内存表）。 */
  function internMessageEvent(
    params: {
      isGroup: boolean;
      targetId: number;
      sequence: number;
      ntSequence?: number;
      wireId: string;
      random: number;
      timestamp: number;
    },
    event: Record<string, unknown>,
  ): number {
    const wireId = params.wireId || `history-${messageIdSeed++}`;
    const id = messageIds.intern({
      wireId,
      peerId: String(params.targetId),
      seq: params.sequence,
      at: Date.now(),
    });
    store.put(id, {
      meta: {
        isGroup: params.isGroup,
        targetId: params.targetId,
        sequence: params.sequence,
        ...(params.ntSequence !== undefined ? { ntSequence: params.ntSequence } : {}),
        sequenceAuthoritative: params.sequence > 0,
        eventName: params.isGroup ? 'group' : 'private',
        clientSequence: 0,
        random: params.random,
        timestamp: params.timestamp,
      },
      event,
    });
    return id;
  }

  function context(): ActionContext {
    return {
      selfId: options.selfId,
      backend: options.backend,
      messageFormat: 'array',
      startedAt,
      internSentMessageId,
      resolveMessageMeta: (messageId): RecallTarget | null => store.meta(messageId) ?? null,
      resolveMessageEvent: (messageId) => store.get(messageId)?.event ?? null,
      internMessageEvent,
      findLatestMessageAnchor: (isGroup, targetId) =>
        store.latestSequence(isGroup, targetId) ?? null,
    };
  }

  const dispatch: ActionDispatcher = async (action, params, options) => {
    // 每个网络有自己的 messageFormat，ack 时用默认 array；事件已经各自处理。
    // echo 必须原样回传：客户端靠它把响应和请求配对。
    const started = Date.now();
    const response = registry.call(
      action,
      params,
      context(),
      options?.echo as JsonValue | undefined,
    );
    // action 调用流水：只记录**真实发生**的调用（1404 也记，那说明客户端在调一个
    // 不存在的 action）。`dispatch` 是所有网络 + WebUI 调试页的唯一入口，埋点放
    // 这里才不会两处漂移。
    const observer = options?.observer ?? options?.onActionCall;
    if (observer) {
      const settled = await response;
      const record = settled as { status?: string; retcode?: number };
      observer({
        ts: started,
        action,
        params,
        retcode: record.retcode ?? -1,
        status: record.status === 'ok' ? 'ok' : 'failed',
        latencyMs: Date.now() - started,
        transport: options?.transport ?? 'ws',
        client: options?.client ?? 'unknown',
      });
      return settled;
    }
    return response;
  };

  /** 一个事件 → 所有连接（各连接自己决定格式）。 */
  async function onBotEvent(event: BotEvent): Promise<void> {
    const converted = await convertEvent(
      {
        selfId: options.selfId,
        messageFormat: 'array',
        reportSelfMessage: true,
        ...(options.imageUrlResolver ? { imageUrlResolver: options.imageUrlResolver } : {}),
        ...(options.mediaUrlResolver ? { mediaUrlResolver: options.mediaUrlResolver } : {}),
        internMessageId: (message) => {
          const id = messageIds.intern({
            wireId: message.messageId,
            peerId: message.peer.id,
            seq: message.seq,
            at: Date.now(),
          });
          // 缓存事件快照，供 `get_msg` 原样返回。
          store.put(id, {
            meta: {
              isGroup: message.scene === 'group',
              targetId: Number(message.peer.id) || 0,
              sequence: message.seq,
              ...(message.ntMsgSeq !== undefined ? { ntSequence: message.ntMsgSeq } : {}),
              sequenceAuthoritative: true,
              eventName: message.scene,
              clientSequence: message.clientSequence ?? 0,
              random: message.random ?? 0,
              timestamp: message.time,
            },
            event: {},
          });
          return id;
        },
      },
      event,
    );
    if (!converted) return;
    // 自己发出的消息保留 `message_sent` 语义；只有声明要收的连接才推。
    const selfMessage = converted.post_type === 'message_sent';
    for (const network of networks) {
      if (selfMessage && !network.reportSelfMessage) continue;
      network.broadcast(converted);
    }
    // 消息事件补存完整快照（`get_msg` 用）。
    if (event.type === 'message') {
      const id = messageIds.intern({
        wireId: event.message.messageId,
        peerId: event.message.peer.id,
        seq: event.message.seq,
        at: Date.now(),
      });
      store.put(id, {
        meta: {
          isGroup: event.message.scene === 'group',
          targetId: Number(event.message.peer.id) || 0,
          sequence: event.message.seq,
          ...(event.message.ntMsgSeq !== undefined ? { ntSequence: event.message.ntMsgSeq } : {}),
          sequenceAuthoritative: true,
          eventName: event.message.scene,
          clientSequence: event.message.clientSequence ?? 0,
          random: event.message.random ?? 0,
          timestamp: event.message.time,
        },
        event: converted,
      });
    }
  }

  /**
   * 启动所有已启用的网络适配器。
   *
   * **失败必须干净回滚**：以前这里是裸循环，第 N 个监听撞端口时，前 N-1 个已经
   * 在监听却没人关 —— 进程还活着、端口被自己占着，用户重试一次还是失败，只能杀
   * 进程。现在任一步失败都会把已启动的逐个 `stop()`，并抛出带
   * `{ network, kind, host, port }` 的 {@link WeqBotError}，让宿主能定位到具体
   * 是哪一条配置的问题。
   *
   * **不做端口顺延**：客户端把 `ws://127.0.0.1:6700` 写死在配置里，悄悄换到
   * 6701 只会让用户看到「运行中」却连不上。
   */
  async function startNetworks(): Promise<number | undefined> {
    let firstPort: number | undefined;
    const { networks: config } = options.config;

    /** 已启动的适配器（失败回滚用；成功后并入 `networks`）。 */
    const startedAdapters: NetworkAdapter[] = [];

    const fail = (
      where: { network: string; kind: string; host: string; port: number },
      cause: unknown,
    ) => {
      const reason = cause instanceof Error ? cause.message : String(cause);
      const busy = isAddressInUse(cause);
      return new WeqBotError(
        'ONEBOT_LISTEN_FAILED',
        busy
          ? `端口 ${where.port} 已被占用（${where.kind}「${where.network}」）`
          : `${where.kind}「${where.network}」的 ${where.host}:${where.port} 启动失败：${reason}`,
        { cause, fields: { ...where, addressInUse: busy } },
      );
    };

    /**
     * 给每个网络适配器包一层，把 `transport` / `client` 与观测钩子带上。
     * 网络层本身不需要知道「怎么记录」。
     */
    const dispatchFor =
      (transport: 'ws' | 'http', client: string): ActionDispatcher =>
      (action, params, dispatchOptions) =>
        dispatch(action, params, {
          ...dispatchOptions,
          transport,
          client,
          ...(options.onActionCall ? { onActionCall: options.onActionCall } : {}),
        });

    try {
      for (const server of config.httpServers) {
        if (server.enabled === false) continue;
        const adapter = new HttpServerAdapter(
          {
            ...(server.name ? { name: server.name } : {}),
            host: server.host ?? '127.0.0.1',
            port: server.port,
            ...(server.path ? { path: server.path } : {}),
            ...(server.accessToken ? { accessToken: server.accessToken } : {}),
            messageFormat: server.messageFormat,
            reportSelfMessage: server.reportSelfMessage,
            ...(server.enableWebSocket ? { enableWebSocket: true } : {}),
          },
          dispatchFor('http', server.name),
        );
        try {
          const port = await adapter.start();
          firstPort ??= port;
        } catch (cause) {
          throw fail(
            {
              network: server.name,
              kind: 'http-server',
              host: server.host ?? '127.0.0.1',
              port: server.port,
            },
            cause,
          );
        }
        startedAdapters.push(adapter);
        log.info('HTTP 服务端已启动', { name: server.name, port: server.port });
      }

      for (const server of config.wsServers) {
        if (server.enabled === false) continue;
        const adapter = new WsServerAdapter(
          {
            ...(server.name ? { name: server.name } : {}),
            host: server.host ?? '127.0.0.1',
            port: server.port,
            ...(server.path ? { path: server.path } : {}),
            ...(server.role ? { role: server.role } : {}),
            ...(server.accessToken ? { accessToken: server.accessToken } : {}),
            messageFormat: server.messageFormat,
            reportSelfMessage: server.reportSelfMessage,
          },
          dispatchFor('ws', server.name),
        );
        try {
          const port = await adapter.start();
          firstPort ??= port;
        } catch (cause) {
          throw fail(
            {
              network: server.name,
              kind: 'ws-server',
              host: server.host ?? '127.0.0.1',
              port: server.port,
            },
            cause,
          );
        }
        startedAdapters.push(adapter);
        log.info('正向 WS 已启动', { name: server.name, port: server.port });
      }

      // 反向 WS 与 HTTP 上报都是**主动去连**别人的客户端：`start()` 不抛错
      // （连不上就按 `reconnectIntervalMs` 退避重连），所以它们不参与回滚。
      for (const client of config.wsClients) {
        if (client.enabled === false) continue;
        const adapter = new WsClientAdapter(
          {
            ...(client.name ? { name: client.name } : {}),
            url: client.url,
            ...(client.role ? { role: client.role } : {}),
            ...(client.accessToken ? { accessToken: client.accessToken } : {}),
            messageFormat: client.messageFormat,
            reportSelfMessage: client.reportSelfMessage,
            ...(client.reconnectIntervalMs
              ? { reconnectIntervalMs: client.reconnectIntervalMs }
              : {}),
            selfId: options.selfId,
          },
          dispatchFor('ws', client.name),
        );
        adapter.start();
        startedAdapters.push(adapter);
        log.info('反向 WS 已连接', { name: client.name, url: client.url });
      }

      for (const client of config.httpClients) {
        if (client.enabled === false) continue;
        const adapter = new HttpClientAdapter({
          ...(client.name ? { name: client.name } : {}),
          url: client.url,
          ...(client.accessToken ? { accessToken: client.accessToken } : {}),
          messageFormat: client.messageFormat,
          reportSelfMessage: client.reportSelfMessage,
        });
        startedAdapters.push(adapter);
        log.info('HTTP 上报已配置', { name: client.name, url: client.url });
      }
    } catch (cause) {
      // 回滚：逆序关掉已经起来的（后起的先关），再清空。
      for (const adapter of startedAdapters.reverse()) {
        try {
          await adapter.stop();
        } catch (stopCause) {
          log.warn('回滚时关闭网络失败', {
            cause: stopCause instanceof Error ? stopCause.message : String(stopCause),
          });
        }
      }
      throw cause;
    }

    networks.push(...startedAdapters);
    return firstPort;
  }

  /** `EADDRINUSE` 在三个平台上的 `code` 都是它，但拿不到时退回文案匹配。 */
  function isAddressInUse(cause: unknown): boolean {
    if (!(cause instanceof Error)) return false;
    const code = (cause as NodeJS.ErrnoException).code;
    return code === 'EADDRINUSE' || /EADDRINUSE|address already in use/i.test(cause.message);
  }

  const adapter: OneBotAdapter = {
    port: undefined,

    actions: () => registered,
    skipped: () => skipped,
    describe: () => registry.describe(),

    networks: () =>
      networks.map(
        (network) =>
          network.snapshot?.() ?? {
            kind: 'http-client' as const,
            name: 'unknown',
            endpoint: '',
            state: 'stopped' as const,
            clients: 0,
          },
      ),

    /**
     * 进程内直接分发：与网络层走同一个注册表与 `dispatch`，因此鉴权 / 敏感
     * action / 未注册能力的语义完全一致。`echo` 固定为 undefined（调用方是 WebUI，
     * 拿的是返回值本身，不靠 echo 配对）。
     */
    call: (action, params) => dispatch(action, params, { transport: 'webui', client: 'webui' }),

    async start() {
      if (starting) return starting;
      if (started) throw new Error('OneBot 适配器已经启动');
      started = true;
      startedAt = Date.now();
      const run = (async () => {
        // 只在第一次注册：`start()` 失败后允许重试（改好端口再保存），而
        // `ActionRegistry.register` 对重名是**硬报错**，重复注册会让第二次
        // 启动永远失败。注册本身与网络无关，失败那轮也已完成。
        if (registered.length === 0 && skipped.length === 0) {
          const result = registerActions(registry, options.backend);
          registered = result.registered;
          skipped = result.skipped;
          log.info('action 已注册', {
            registered: registered.length,
            skipped,
            backend: describeBackend(options.backend),
          });
        }

        const port = await startNetworks();
        (adapter as { port: number | undefined }).port = port;

        // `createBot` 对每条事件都会 emit `'event'`；但宿主也可能只 emit
        // 具体类型（`message` / `notice`）。两路都订阅，用 seen 去重。
        const seen = new WeakSet<object>();
        const deliver = (event: BotEvent): void => {
          if (typeof event !== 'object' || event === null) return;
          if (seen.has(event)) return;
          seen.add(event);
          void onBotEvent(event);
        };
        unsubscribers.push(
          options.events.on('event', deliver),
          options.events.on('message', (message) =>
            deliver({ type: 'message', message } as BotEvent),
          ),
          options.events.on('notice', (notice) => deliver(notice)),
        );

        for (const network of networks) {
          network.broadcast(lifecycleMetaEvent(options.selfId, 'connect'));
        }

        const heartbeatMs = options.heartbeatMs ?? 30_000;
        if (heartbeatMs > 0) {
          const timer = setInterval(() => {
            const event = heartbeatMetaEvent(options.selfId, heartbeatMs);
            for (const network of networks) network.broadcast(event);
          }, heartbeatMs);
          timer.unref?.();
          stopHeartbeat = () => clearInterval(timer);
        }
      })();
      starting = run;
      try {
        await run;
      } catch (cause) {
        // 失败后必须复位，否则下一次 start() 会直接拿回这个 rejected promise：
        // 用户改好端口再保存也永远失败，只能重启进程。`startNetworks` 已经把自己
        // 起来的适配器关干净，这里只清本层的簿记。
        started = false;
        starting = undefined;
        (adapter as { port: number | undefined }).port = undefined;
        throw cause;
      }
      return run;
    },

    async stop() {
      // 先退订，避免关网络时还在往里写。
      for (const off of unsubscribers) off();
      unsubscribers = [];
      stopHeartbeat?.();
      stopHeartbeat = undefined;
      for (const network of networks)
        network.broadcast(lifecycleMetaEvent(options.selfId, 'disable'));
      for (const network of [...networks].reverse()) {
        await network.stop();
      }
      networks.length = 0;
      started = false;
      starting = undefined;
    },
  };

  return adapter;
}

export type { MessageFormat };
