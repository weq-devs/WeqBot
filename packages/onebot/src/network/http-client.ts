/**
 * HTTP 上报（反向）：把事件 POST 到配置的 URL。
 *
 * 与 SnowLuma 一致，失败只记状态不重试 —— 上报端自己会重发。
 */

import type { JsonObject } from '../types';
import type { NetworkSnapshot } from './index';

export interface HttpClientOptions {
  /** 配置里的名字，只用于状态快照展示。 */
  name?: string;
  url: string;
  accessToken?: string;
  timeoutMs?: number;
  messageFormat: 'array' | 'string';
  reportSelfMessage: boolean;
}

export class HttpClientAdapter {
  private lastError: string | undefined;
  private delivered = false;

  constructor(private readonly options: HttpClientOptions) {}

  /** 观测快照（WebUI 网络页 / 总览）。上报端没有连接状态，只反映最近一次成功 / 失败。 */
  snapshot(): NetworkSnapshot {
    return {
      kind: 'http-client',
      name: this.options.name ?? `http-client:${this.options.url}`,
      endpoint: this.options.url,
      state: this.lastError ? 'error' : this.delivered ? 'connected' : 'connecting',
      clients: this.delivered && !this.lastError ? 1 : 0,
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  async broadcast(event: JsonObject): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 5000);
    timeout.unref?.();
    try {
      const response = await fetch(this.options.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.options.accessToken
            ? { authorization: `Bearer ${this.options.accessToken}` }
            : {}),
        },
        body: JSON.stringify(event),
        signal: controller.signal,
      });
      // 非 2xx 也算失败：上报端没收到就等于事件丢了。
      this.delivered = response.ok;
      this.lastError = response.ok ? undefined : `HTTP ${response.status}`;
    } catch (cause) {
      // 上报失败不重试：OneBot 的事件通道本来就是尽力而为。
      this.delivered = false;
      this.lastError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      clearTimeout(timeout);
    }
  }

  /** `report_self_message`：为 false 的连接不推 `message_sent`。 */
  get reportSelfMessage(): boolean {
    return this.options.reportSelfMessage ?? true;
  }

  async stop(): Promise<void> {}
}
