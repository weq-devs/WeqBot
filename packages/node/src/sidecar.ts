/**
 * `--sidecar`：desktop / WeQ 拉起的一次性独立进程。
 *
 * 传输是 NDJSON over stdio（契约与编解码在 `@weqbot/control`）。生命周期由宿主
 * 掌握：`login` 交付凭据后开始上线，`shutdown` 或 **stdin 关闭**（宿主退出 /
 * 崩溃）都让 sidecar 自己退出 —— 后者是 V10 的验收点，不依赖父进程的 signal。
 *
 * 会话本身（login / status / 事件）在 `control-host.ts`，这里只管「怎么收发」和
 * 「什么时候退」。常驻形态见 `daemon.ts`。
 */

import { createLogger, type Logger } from '@weqbot/common';
import type { BotConfig } from '@weqbot/bot';
import {
  ControlLineDecoder,
  controlFailure,
  encodeEnvelope,
  type ControlEnvelope,
} from '@weqbot/control';
import type { CredentialVault } from '@weqbot/session';
import type { NativePort } from '@weqbot/wire';
import { createControlHost, failureOf, type ControlHostOptions } from './control-host';

export interface SidecarOptions {
  /** 账号由 spawn 时决定，控制通道拿不到第二个账号。 */
  uin: string;
  native: NativePort;
  vault: CredentialVault;
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  logger?: Logger;
  /** 启动期配置；不接受凭据，a1 仍然只从控制通道来。 */
  config?: Omit<BotConfig, 'account'>;
  /** 注入点：测试用假 Bot，生产用 createBot。 */
  botFactory?: ControlHostOptions['botFactory'];
  /** 退出回调（默认 `process.exit(0)`）；测试里替换掉。 */
  onExit?: (code: number) => void;
}

export interface SidecarHandle {
  /** 主动关闭（测试 / 宿主显式调用）。 */
  close(): Promise<void>;
}

export function runSidecar(options: SidecarOptions): SidecarHandle {
  const log = options.logger ?? createLogger('sidecar');
  const onExit = options.onExit ?? ((code: number) => process.exit(code));
  const decoder = new ControlLineDecoder();

  const write = (envelope: ControlEnvelope): void => {
    options.stdout.write(encodeEnvelope(envelope));
  };

  const host = createControlHost({
    uin: options.uin,
    native: options.native,
    vault: options.vault,
    logger: log,
    ...(options.config ? { config: options.config } : {}),
    ...(options.botFactory ? { botFactory: options.botFactory } : {}),
    onShutdown: () => onExit(0),
  });

  host.subscribe(write);

  options.stdin.on('data', (chunk: Uint8Array) => {
    let envelopes: ControlEnvelope[];
    try {
      envelopes = decoder.push(chunk);
    } catch (cause) {
      write(controlFailure(0, failureOf(cause)));
      return;
    }
    for (const envelope of envelopes) void host.handle(envelope, write);
  });

  // 宿主退出 / 崩溃：stdin 关闭即自杀（V10）。
  const onEnd = (): void => {
    log.info('stdin 已关闭，sidecar 自行退出');
    void host.close('parent-gone');
  };
  options.stdin.on('end', onEnd);
  options.stdin.on('close', onEnd);

  return {
    async close() {
      await host.close('closed');
    },
  };
}
