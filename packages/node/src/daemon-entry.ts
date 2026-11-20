/**
 * 供宿主的打包入口：只跑 `--serve` daemon，**不带 WebUI**。
 *
 * 为什么单独一个入口：WeQ 只需要 kernel + 控制通道，不需要 weqbot 的控制台
 * （管理界面由 WeQ 自己在 Electron 里实现）。走 `cli.mjs --serve` 也能跑，但那
 * 份 bundle 里带着整个 WebUI 服务和 SPA 静态资源，宿主包里白搭几 MB，还会让
 * 「sidecar 模式绝不监听 HTTP 控制台」这条边界变得靠参数维持而不是靠结构。
 *
 * 参数与 `weqbot --serve` 完全一致：
 *
 *   weqbot-daemon.mjs --account <uin> [--socket <path>] [--config <path>]
 *
 * 与 CLI 的差异只有两处：
 *   1. 找不到 native 时报错退出（宿主应当配好 `WEQBOT_NATIVE_DIR`）；
 *   2. 日志只走 stderr —— stdout 留给可能被重定向的诊断输出。
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger, configureLogging } from '@weqbot/common';
import { adaptNativeBinding } from '@weqbot/wire';
import { FileCredentialVault } from '@weqbot/session';
import { loadConfigFile, mergeConfig } from './config';
import { runDaemon } from './daemon';
import { loadNative } from './loader';

interface Args {
  account?: string;
  socket?: string;
  config?: string;
  nativeDir?: string;
  logLevel?: string;
}

function parseArgs(argv: readonly string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    const value = (): string | undefined => {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) return undefined;
      i += 1;
      return next;
    };
    switch (flag) {
      case '--account':
        out.account = value();
        break;
      case '--socket':
        out.socket = value();
        break;
      case '--config':
        out.config = value();
        break;
      case '--native-dir':
        out.nativeDir = value();
        break;
      case '--log-level':
        out.logLevel = value();
        break;
      default:
        break;
    }
  }
  return out;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  if (!args.account) {
    process.stderr.write('weqbot-daemon 需要 --account <uin>\n');
    return 2;
  }

  configureLogging({
    ...(args.logLevel ? { level: args.logLevel as never } : {}),
    dir: null,
  });
  const log = createLogger('daemon-entry');

  const fileConfig = args.config ? await loadConfigFile(args.config) : undefined;
  const loaded = loadNative({
    ...(args.nativeDir ? { dir: args.nativeDir } : {}),
  });
  const native = adaptNativeBinding(loaded.binding);

  const vaultDir = process.env.WEQBOT_VAULT_DIR ?? join(homedir(), '.weqbot', 'accounts');
  const vault = new FileCredentialVault({ dir: vaultDir });

  const { account: _account, ...rest } = mergeConfig({
    ...(fileConfig ? { file: fileConfig } : {}),
    uin: args.account,
  });
  void _account;

  log.info('daemon 启动', { uin: args.account, native: loaded.path });

  const daemon = await runDaemon({
    uin: args.account,
    native,
    vault,
    logger: log,
    ...(Object.keys(rest).length > 0 ? { config: rest } : {}),
    ...(args.socket ? { socketPath: args.socket } : {}),
  });

  // 信号 → 优雅下线（`closeSession` → `UnRegister`）。宿主被打断时也要走这条路，
  // 否则手机端会一直显示「电脑在线」。
  const stop = (signal: string): void => {
    log.info('收到退出信号，开始下线', { signal });
    void daemon.close(signal);
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.once(signal, () => stop(signal));
  }

  log.info('daemon 已就绪，等待控制通道连接', {
    uin: args.account,
    socket: daemon.socketPath,
  });
  return -1;
}

// 直接执行时进 main；被测试 import 时不自动跑。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().then((code) => {
    if (code >= 0) process.exit(code);
  });
}
