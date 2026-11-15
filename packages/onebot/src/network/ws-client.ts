/**
 * 反向 WS：本进程连到 OneBot 客户端（NapCat 的「HTTP/WS 上报」等）。
 *
 * 借 SnowLuma `ws-client-adapter.ts`：握手头带 `X-Self-ID` / `X-Client-Role`、
 * 固定间隔重连、心跳保活。用 `ws` 实现，纯 JS。
 */

import { WebSocket, type WsSocket } from './ws-module';
import {
  DEFAULT_MAX_PAYLOAD_BYTES,
  canReceiveAction,
  canReceiveEvent,
  MAX_BUFFERED_BYTES,
  type NetworkSnapshot,
} from './index';
import type { ActionDispatcher } from '../adapter';
import type { JsonObject, MessageFormat, WsRole } from '../types';

export interface WsClientOptions {
  /** 配置里的名字，只用于状态快照展示。 */
  name?: string;
  url: string;
  role?: WsRole;
  accessToken?: string;
  messageFormat: MessageFormat;
  reportSelfMessage: boolean;
  reconnectIntervalMs?: number;
  maxPayloadBytes?: number;
  selfId: number;
}

export class WsClientAdapter {
  private socket: WsSocket | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private connected = false;
  private lastError: string | undefined;

  constructor(
    private readonly options: WsClientOptions,
    private readonly dispatch: ActionDispatcher,
  ) {}

  private get role(): WsRole {
    return this.options.role ?? 'Universal';
  }

  /** `report_self_message`：为 false 的连接不推 `message_sent`。 */
  get reportSelfMessage(): boolean {
    return this.options.reportSelfMessage ?? true;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  private connect(): void {
    if (this.stopped) return;

    const headers: Record<string, string> = {
      'X-Self-ID': String(this.options.selfId),
      'X-Client-Role': this.role,
      'User-Agent': 'OneBot/11',
    };
    if (this.options.accessToken) {
      headers.Authorization = `Bearer ${this.options.accessToken}`;
    }

    const socket = new WebSocket(this.options.url, {
      headers,
      maxPayload: this.options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
    });
    this.socket = socket;

    socket.on('open', () => {
      this.connected = true;
      this.lastError = undefined;
      this.startHeartbeat();
    });
    socket.on('message', (raw) => {
      void this.onMessage(raw.toString());
    });
    socket.on('close', () => {
      this.connected = false;
      this.stopHeartbeat();
      this.scheduleReconnect();
    });
    socket.on('error', (cause: Error) => {
      // `close` 会跟着来，重连在那里统一处理；这里只记下最近的错误给状态快照。
      this.lastError = cause.message;
    });
  }

  /** 观测快照（WebUI 网络页 / 总览）。 */
  snapshot(): NetworkSnapshot {
    return {
      kind: 'ws-client',
      name: this.options.name ?? `ws-client:${this.options.url}`,
      endpoint: this.options.url,
      state: this.stopped
        ? 'stopped'
        : this.connected
          ? 'connected'
          : this.lastError
            ? 'error'
            : 'connecting',
      clients: this.connected ? 1 : 0,
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      const socket = this.socket;
      if (socket && socket.readyState === socket.OPEN) socket.ping();
    }, 30_000);
    this.heartbeat.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.timer) return;
    const delay = Math.max(this.options.reconnectIntervalMs ?? 5000, 1000);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.connect();
    }, delay);
    this.timer.unref?.();
  }

  private async onMessage(text: string): Promise<void> {
    if (!canReceiveAction(this.role)) return;

    let request: { action?: unknown; params?: unknown; echo?: unknown };
    try {
      request = JSON.parse(text) as typeof request;
    } catch {
      this.send({
        status: 'failed',
        retcode: 1400,
        data: null,
        wording: '请求不是合法 JSON',
      });
      return;
    }

    const action = typeof request.action === 'string' ? request.action : '';
    const params = (request.params ?? {}) as JsonObject;
    this.send(await this.dispatch(action, params, { echo: request.echo }));
  }

  broadcast(event: JsonObject): void {
    if (canReceiveEvent(this.role)) this.send(event);
  }

  private send(payload: unknown): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      socket.close(1008, 'client too slow');
      return;
    }
    socket.send(JSON.stringify(payload));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.connected = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.stopHeartbeat();
    const socket = this.socket;
    this.socket = undefined;
    if (socket) socket.close(1000, 'shutdown');
  }
}
