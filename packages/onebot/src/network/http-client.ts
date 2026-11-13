/**
 * HTTP 上报（反向）：把事件 POST 到配置的 URL。
 *
 * 与 SnowLuma 一致，失败只记状态不重试 —— 上报端自己会重发。
 */

import type { JsonObject } from '../types';

export interface HttpClientOptions {
  url: string;
  accessToken?: string;
  timeoutMs?: number;
  messageFormat: 'array' | 'string';
  reportSelfMessage: boolean;
}

export class HttpClientAdapter {
  constructor(private readonly options: HttpClientOptions) {}

  async broadcast(event: JsonObject): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 5000);
    timeout.unref?.();
    try {
      await fetch(this.options.url, {
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
    } catch {
      // 上报失败不重试：OneBot 的事件通道本来就是尽力而为。
    } finally {
      clearTimeout(timeout);
    }
  }

  async stop(): Promise<void> {}
}
