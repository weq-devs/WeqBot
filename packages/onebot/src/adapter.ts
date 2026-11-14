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

import { createLogger, type Logger } from '@weqbot/common';
import type { BotEvent, BotEventMap } from '@weqbot/session';

type BotEventMapEvent<K extends keyof BotEventMap> = BotEventMap[K];
import { ActionRegistry, type ActionContext } from './action-registry';
import { registerActions } from './actions';
import { describeBackend, type OneBotBackend, type RecallTarget } from './backend';
import { convertEvent, heartbeatMetaEvent, lifecycleMetaEvent } from './event-converter';
import { MessageIdMap } from './message-id';
import { MessageStore } from './message-store';
import type { JsonObject, JsonValue, MessageFormat, OneBotConfig } from './types';
import { HttpClientAdapter } from './network/http-client';
import { HttpServerAdapter } from './network/http-server';
import { WsClientAdapter } from './network/ws-client';
import { WsServerAdapter } from './network/ws-server';

/** 网络适配器的最小公共面。 */
interface NetworkAdapter {
  broadcast(event: JsonObject): void;
  stop(): Promise<void>;
  /** `report_self_message`：false 时不推自己发出的消息。 */
  readonly reportSelfMessage: boolean;
}

export interface ActionDispatchOptions {
  echo?: unknown;
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
}

export interface OneBotAdapter {
  readonly port: number | undefined;
  /** 当前注册成功的 action 名。 */
  actions(): string[];
  /** 被跳过（后端没实现 / 敏感能力）的 action 名。 */
  skipped(): string[];
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

  function context(): ActionContext {
    return {
      selfId: options.selfId,
      backend: options.backend,
      messageFormat: 'array',
      startedAt,
      internSentMessageId,
      resolveMessageMeta: (messageId): RecallTarget | null => store.meta(messageId) ?? null,
      resolveMessageEvent: (messageId) => store.get(messageId)?.event ?? null,
    };
  }

  const dispatch: ActionDispatcher = async (action, params, options) => {
    // 每个网络有自己的 messageFormat，ack 时用默认 array；事件已经各自处理。
    // echo 必须原样回传：客户端靠它把响应和请求配对。
    return registry.call(action, params, context(), options?.echo as JsonValue | undefined);
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

  async function startNetworks(): Promise<number | undefined> {
    let firstPort: number | undefined;
    const { networks: config } = options.config;

    for (const server of config.httpServers) {
      if (server.enabled === false) continue;
      const adapter = new HttpServerAdapter(
        {
          host: server.host ?? '127.0.0.1',
          port: server.port,
          ...(server.path ? { path: server.path } : {}),
          ...(server.accessToken ? { accessToken: server.accessToken } : {}),
          messageFormat: server.messageFormat,
          reportSelfMessage: server.reportSelfMessage,
          ...(server.enableWebSocket ? { enableWebSocket: true } : {}),
        },
        dispatch,
      );
      const port = await adapter.start();
      firstPort ??= port;
      networks.push(adapter);
      log.info('HTTP 服务端已启动', { name: server.name, port });
    }

    for (const server of config.wsServers) {
      if (server.enabled === false) continue;
      const adapter = new WsServerAdapter(
        {
          host: server.host ?? '127.0.0.1',
          port: server.port,
          ...(server.path ? { path: server.path } : {}),
          ...(server.role ? { role: server.role } : {}),
          ...(server.accessToken ? { accessToken: server.accessToken } : {}),
          messageFormat: server.messageFormat,
          reportSelfMessage: server.reportSelfMessage,
        },
        dispatch,
      );
      const port = await adapter.start();
      firstPort ??= port;
      networks.push(adapter);
      log.info('正向 WS 已启动', { name: server.name, port });
    }

    for (const client of config.wsClients) {
      if (client.enabled === false) continue;
      const adapter = new WsClientAdapter(
        {
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
        dispatch,
      );
      adapter.start();
      networks.push(adapter);
      log.info('反向 WS 已连接', { name: client.name, url: client.url });
    }

    for (const client of config.httpClients) {
      if (client.enabled === false) continue;
      const adapter = new HttpClientAdapter({
        url: client.url,
        ...(client.accessToken ? { accessToken: client.accessToken } : {}),
        messageFormat: client.messageFormat,
        reportSelfMessage: client.reportSelfMessage,
      });
      networks.push(adapter);
      log.info('HTTP 上报已配置', { name: client.name, url: client.url });
    }

    return firstPort;
  }

  const adapter: OneBotAdapter = {
    port: undefined,

    actions: () => registered,
    skipped: () => skipped,

    async start() {
      if (started) throw new Error('OneBot 适配器已经启动');
      if (starting) return starting;
      started = true;
      startedAt = Date.now();
      starting = (async () => {
        const result = registerActions(registry, options.backend);
        registered = result.registered;
        skipped = result.skipped;
        log.info('action 已注册', {
          registered: registered.length,
          skipped,
          backend: describeBackend(options.backend),
        });

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
      return starting;
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
