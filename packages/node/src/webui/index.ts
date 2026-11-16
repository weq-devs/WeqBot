/**
 * `@weqbot/node` 的 WebUI 控制台（P5 后端，W1–W10）。
 *
 * 组装顺序：
 *
 *   loadNative 出来的原生绑定 → ConsoleRuntime（账号 / 登录 / 总览）
 *   → Observability（三条观测流）→ WebUiAuth（访问令牌）
 *   → createWebUiServer（HTTP + 静态资源）→ createWebUiRouter（路由）
 *
 * 独立进程的两个入口：
 *
 * - `weqbot`（带 `--account`）：先按 CLI 的原有流程上线，再起控制台；
 * - `weqbot`（不带 `--account`）：**只起控制台**，等用户在登录页选账号（W3）。
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BotOneBotConfig, BotConfig } from '@weqbot/bot';
import { createLogger, subscribeLogs, type Logger } from '@weqbot/common';
import type { CredentialVault } from '@weqbot/session';
import type { NativePort, RawNativeBinding } from '@weqbot/wire';
import { WebUiAuth } from './auth';
import { ConsoleRuntime } from './console';
import { saveOneBotConfig, saveQqPaths } from './config-file';
import { HttpError } from './http-util';
import { Observability } from './observability';
import { createWebUiRouter } from './routes';
import { createWebUiServer } from './server';

const here = dirname(fileURLToPath(import.meta.url));

export interface RunWebUiOptions {
  binding: RawNativeBinding;
  native: NativePort;
  vault: CredentialVault;
  /** `--config` 的内容（不含 account）。`config.onebot` 只作为宿主默认值。 */
  config: Omit<BotConfig, 'account'>;
  /** 按账号保存的 OneBot 配置（配置文件的 `onebotByUin`）。 */
  onebotByUin?: Record<string, BotOneBotConfig>;
  /** `--config` 的路径；保存网络配置时写回它。不给时只在内存生效。 */
  configPath?: string;
  /** `qq.dbPath`，用于登录页的「QQ 是否在线」。 */
  qqDbPath?: string;
  /**
   * 配置文件里手动指定的 QQ 路径（`qq.installDir` / `qq.dataDir`）。
   *
   * 优先级高于环境变量与自动探测；设置页保存后也会写回这一份的落盘点。
   */
  qqPaths?: { installDir?: string; dataDir?: string };
  host?: string;
  port?: number;
  /** 固定访问令牌（`WEQBOT_WEBUI_TOKEN`）；不给则每次启动随机生成。 */
  token?: string;
  /** 静态资源目录；默认找 `packages/webui/dist`，不存在时只提供 API。 */
  staticDir?: string;
  logger?: Logger;
}

export interface WebUiHandle {
  readonly port: number;
  readonly token: string;
  /** 一键链接（`#token=` 的 hash 不走服务端日志）。 */
  readonly url: string;
  readonly runtime: ConsoleRuntime;
  close(): Promise<void>;
}

/** `packages/webui/dist`；源码直接跑时相对本文件，打包后相对 cwd。 */
export function defaultStaticDir(): string | undefined {
  const candidates = [
    resolve(here, '..', '..', '..', 'webui', 'dist'),
    resolve(here, '..', '..', '..', '..', 'webui', 'dist'),
    resolve(process.cwd(), 'packages', 'webui', 'dist'),
  ];
  return candidates.find((candidate) => existsSync(join(candidate, 'index.html')));
}

export async function runWebUi(options: RunWebUiOptions): Promise<WebUiHandle> {
  const log = options.logger ?? createLogger('webui');
  const observability = new Observability();
  const auth = new WebUiAuth(options.token);
  const runtime = new ConsoleRuntime({
    native: options.native,
    binding: options.binding,
    vault: options.vault,
    config: options.config,
    ...(options.onebotByUin ? { onebotByUin: options.onebotByUin } : {}),
    ...(options.qqDbPath ? { qqDbPath: options.qqDbPath } : {}),
    ...(options.qqPaths ? { qqPathsOverride: options.qqPaths } : {}),
    // WebUI 自己的日志器挂上观测 sink：终端照常输出，页面也能看到。
    logger: log,
    observability,
  });

  const router = createWebUiRouter({
    auth,
    console: runtime,
    observability,
    logger: log,
    readConfig: () => runtime.oneBotConfigFor(runtime.boundUin),
    ...(options.configPath ? { configPath: options.configPath } : {}),
    // 网络配置属于当前账号：没有账号时不写全局文件，否则切号会串配置。
    saveConfig: async (config: BotOneBotConfig) => {
      const uin = runtime.boundUin;
      if (!uin) throw new HttpError(409, 'NO_ACCOUNT', '先登录账号，再保存这个账号的网络配置');
      if (options.configPath) await saveOneBotConfig(options.configPath, uin, config);
      runtime.rememberOneBotConfig(uin, config);
    },
    // QQ 路径不属于任何账号，任何阶段都能改。
    saveQqPaths: async (patch) => {
      if (options.configPath) await saveQqPaths(options.configPath, patch);
    },
  });

  const staticDir = options.staticDir ?? defaultStaticDir();
  const server = createWebUiServer({
    ...(options.host ? { host: options.host } : {}),
    port: options.port ?? 6299,
    ...(staticDir ? { staticDir } : {}),
    handle: (input) => router.handle(input),
    logger: log,
  });

  const handle = await server.start();
  const token = auth.plainToken;
  const url = `http://${options.host ?? '127.0.0.1'}:${handle.port}/#token=${token}`;

  // 运行日志同时进观测缓冲：日志页的「运行日志」流靠它，终端照旧输出。
  const unsubscribeLogs = subscribeLogs(observability.logSink);

  log.debug('控制台已就绪', {
    url: `http://${options.host ?? '127.0.0.1'}:${handle.port}/`,
    ...(staticDir ? { staticDir } : { hint: '没找到 webui/dist，只提供 API' }),
  });
  // 令牌只打印到终端：它不进日志 / 响应体，用户从终端拿。
  process.stdout.write(
    ['', '  WeqBot 控制台已启动', `  打开：${url}`, `  令牌：${token}`, ''].join('\n'),
  );

  return {
    port: handle.port,
    token,
    url,
    runtime,
    async close() {
      unsubscribeLogs();
      await runtime.close();
      await handle.close();
    },
  };
}

export { WebUiAuth } from './auth';
export { ConsoleRuntime, type LoginEnvironment } from './console';
export { Observability } from './observability';
export { discoverQqPaths, type QqPathOverrides, type QqPaths } from './qq-paths';
export { detectQqHints, ensureQqHints, type QqHints } from './qq-detect';
export { findNtMsgDb } from './qq-account';
