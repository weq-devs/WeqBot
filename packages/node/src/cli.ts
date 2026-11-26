#!/usr/bin/env node
/**
 * 独立进程入口（骨架）。
 *
 * 现在只做两件真事：加载 native、打印能力报告。
 * 完整的启动流程（vault → quickLogin → openSession → OneBot）在 P3/P4 落地，
 * 见 `TODO.md`「阶段计划」。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createBot, describeBot, type BotConfig } from '@weqbot/bot';
import { configureLogging, createLogger, type LogLevel } from '@weqbot/common';
import { FileCredentialVault } from '@weqbot/session';
import { adaptNativeBinding, inspectNative } from '@weqbot/wire';
import { ConfigError, loadConfigFile, mergeConfig, type LoadedConfig } from './config';
import { loadNative } from './loader';
import { runDaemon } from './daemon';
import { runSidecar } from './sidecar';
import { ATTACH_WORKER_FLAG, runAttachWorker } from './webui/attach';
import { runWebUi } from './webui';

/** 独立进程的默认凭据目录；`WEQBOT_VAULT_DIR` 可覆盖（测试 / 多实例）。 */
function defaultVaultDir(): string {
  return process.env.WEQBOT_VAULT_DIR ?? join(homedir(), '.weqbot', 'accounts');
}

/** 日志目录；`WEQBOT_LOG_DIR=off` 关闭落盘（WeQ 嵌入 / 只读环境）。 */
function resolveLogDir(): string | null {
  const configured = process.env.WEQBOT_LOG_DIR;
  if (configured === 'off') return null;
  return configured && configured.trim() !== '' ? configured : join(process.cwd(), 'logs');
}

/** `--trace` > `--verbose` > `WEQBOT_LOG_LEVEL`；都没有则交由 logger 的默认值。 */
function resolveLogLevel(values: { verbose?: boolean; trace?: boolean }): LogLevel | undefined {
  if (values.trace) return 'trace';
  if (values.verbose) return 'debug';
  return undefined;
}

/**
 * 从配置文件里挑出控制台要用的 QQ 路径。
 *
 * 一个都没配时返回 undefined，让 `runWebUi` 完全走自动探测（避免传进去一个空对象
 * 后 `sources` 里多出一项 `override`）。
 */
function pickQqPaths(
  qq: LoadedConfig['qq'],
): { installDir?: string; dataDir?: string } | undefined {
  const installDir = qq?.installDir;
  const dataDir = qq?.dataDir;
  if (!installDir && !dataDir) return undefined;
  return {
    ...(installDir ? { installDir } : {}),
    ...(dataDir ? { dataDir } : {}),
  };
}

/**
 * `--sidecar` / `--serve` 的启动期配置：账号由参数定，凭据只从控制通道来。
 *
 * 配置文件里的 `account` 是「上次登录的账号」，不能让sidecar 继承 —— 会变成
 * 一个可被控制通道之外的来源意外切换的账号。
 */
function startupConfig(
  fileConfig: LoadedConfig | undefined,
  uin: string,
): Omit<BotConfig, 'account'> | undefined {
  if (!fileConfig) return undefined;
  const { account: _account, ...rest } = mergeConfig({ file: fileConfig, uin });
  void _account;
  return rest;
}

const USAGE = `weqbot — 独立 QQ bot（mode2 自建上线）

用法:
  weqbot                            只启动 WebUI 控制台，在浏览器里选账号登录
  weqbot --account <uin>            启动 bot（并同时提供 WebUI 控制台）
  weqbot --account <uin> --no-webui 只启动 bot，不开控制台
  weqbot --account <uin> --check    只做 native 自检，不连网
  weqbot --print-capabilities       打印原生组件能力
  weqbot --print-capabilities --qq-pid <pid> --account <uin>
                                    额外打印从 QQ 内存读到的 secToken 来源与 TTL
  weqbot --sidecar --account <uin>  desktop 托管模式：控制通道走 stdio
  weqbot --serve --account <uin>    desktop 常驻模式：控制通道走 socket（客户端断开不退出）

选项:
  --account <uin>      账号 uin；不给则只起控制台
  --native-dir <dir>   原生组件目录（默认 $WEQBOT_NATIVE_DIR 或 ./native/<platform>/<arch>）
  --qq-db <path>       账号 nt_msg.db 绝对路径（mode2 预检 isQqLoggedIn 用；
                       也可用 $WEQBOT_QQ_DB）
  --config <path>      JSON 配置：native / qq / session / secToken / onebot / log
                       （不含凭据；字段见 packages/node/config.example.json）
  --webui-port <port>  控制台端口（默认 6299，只听 127.0.0.1）
  --webui-host <host>  控制台监听地址（默认 127.0.0.1；非回环会告警）
  --no-webui           不启动控制台
  --qq-pid <pid>       只与 --print-capabilities 连用：诊断 QQ 进程的会话物料
                       （需要 root / CAP_SYS_PTRACE）
  --check              自检模式
  --sidecar            desktop 拉起的托管模式（NDJSON over stdio，见 @weqbot/control）
  --serve              常驻 daemon 模式（NDJSON over socket；宿主退出不影响 OneBot）
  --socket <path>      --serve 监听的路径（默认 $XDG_RUNTIME_DIR/weqbot/weqbot-<uin>.sock）
  --verbose            打开 debug 日志
  --trace              打开 trace 日志：记录报文命令、长度及耗时
  -h, --help           显示本帮助

环境变量:
  WEQBOT_WEBUI_TOKEN   固定控制台令牌（默认每次启动随机生成并打印）
  WEQBOT_LOG_DIR       日志落盘目录（默认 ./logs；设为 off 关闭落盘）
  WEQBOT_LOG_LEVEL     终端日志级别：trace / debug / info / warn / error
  WEQBOT_TRACE_PACKET_BYTES  设为 1 且启用 trace 时额外打印原始报文字节
  WEQBOT_LOG_FILE_LEVEL 落盘级别（默认 debug；trace 不落盘）
  WEQBOT_QQ_INSTALL_DIR QQ 安装根（含 qq / QQ.exe 的目录；macOS 是 QQ.app）
  WEQBOT_QQ_ROOT       QQ 数据根（默认 ~/.config/QQ 等；不是安装目录）
  WEQBOT_QQ_EXE        QQ 可执行文件（等价于指定安装根，优先级低于上面两个）

控制台「设置」页填的路径存在配置文件 qq.installDir / qq.dataDir，优先级最高。
`;

async function main(argv: string[]): Promise<number> {
  /**
   * 提权子进程入口：必须在 `parseArgs` 之前。
   *
   * 这个模式只收位置参数（native 路径 / pid / uin / uid），而且会以 **root** 跑，
   * 所以不能走正常 CLI 的配置读取、日志落盘和 native 自检 —— 那些一旦报错，
   * 用户会看到一句看不懂的 root 侧报错，而真正原因（密码 / 权限）反而被淹掉。
   */
  const workerIndex = argv.indexOf(ATTACH_WORKER_FLAG);
  if (workerIndex !== -1) {
    await runAttachWorker(argv.slice(workerIndex + 1));
    // runAttachWorker 正常返回只可能是 process.exit 没执行到；不继续往下走，
    // 否则会带着 worker 的位置参数进 parseArgs。
    return 0;
  }

  const { values } = parseArgs({
    args: argv,
    options: {
      account: { type: 'string' },
      'native-dir': { type: 'string' },
      'qq-db': { type: 'string' },
      'qq-pid': { type: 'string' },
      config: { type: 'string' },
      'webui-port': { type: 'string' },
      'webui-host': { type: 'string' },
      'no-webui': { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
      sidecar: { type: 'boolean', default: false },
      serve: { type: 'boolean', default: false },
      socket: { type: 'string' },
      'print-capabilities': { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
      trace: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  // 配置先读再加载 native：native.wrapperPath 可能就写在配置文件里，
  // 而且配置错时不该先去碰一个可能不存在的 `.node`。
  let fileConfig: Awaited<ReturnType<typeof loadConfigFile>> | undefined;
  if (values.config) {
    try {
      fileConfig = await loadConfigFile(values.config);
    } catch (cause) {
      if (cause instanceof ConfigError) {
        process.stderr.write(`${cause.message}\n`);
        return 2;
      }
      throw cause;
    }
  }

  const logDir = resolveLogDir();
  const level = resolveLogLevel(values);
  configureLogging({ ...(level ? { level } : {}), dir: logDir });
  const log = createLogger('cli');
  const loaded = loadNative({
    ...(values['native-dir'] ? { dir: values['native-dir'] } : {}),
    // native 自己的日志进文件，永不占终端：签名 / 发包的 hex 就是从这儿出来的。
    ...(logDir ? { logPath: join(logDir, 'native.log') } : {}),
    debugLog: values.trace,
  });
  const native = adaptNativeBinding(loaded.binding);
  const capabilities = inspectNative(native);

  log.debug('原生组件已加载', {
    path: loaded.path,
    profile: loaded.profile,
    ...(loaded.buildInfo ? { validitySecs: loaded.buildInfo.validitySecs } : {}),
  });

  if (values['print-capabilities']) {
    process.stdout.write(`${capabilities.list().join('\n')}\n`);
    if (values['qq-pid']) {
      // 只打印来源 / TTL，不打印 token 本身 —— 终端输出经常被贴进日志。
      const pid = Number(values['qq-pid']);
      if (!Number.isInteger(pid) || pid <= 0) {
        process.stderr.write(`--qq-pid 不是合法 pid：${values['qq-pid']}\n`);
        return 2;
      }
      if (!loaded.binding.scanSessionMaterial) {
        process.stderr.write('该原生组件没有 scanSessionMaterial，无法诊断 secToken\n');
        return 1;
      }
      try {
        const material = await loaded.binding.scanSessionMaterial(
          pid,
          values.account ?? null,
          null,
        );
        const ttl =
          material.secTokenExpire === undefined
            ? 'unknown'
            : `${material.secTokenExpire - Math.floor(Date.now() / 1000)}s`;
        process.stdout.write(
          `${[
            `secToken: ${material.secToken ? 'present' : 'missing'}`,
            `secTokenSource: ${material.secTokenSource ?? 'unknown'}`,
            `secTokenTtl: ${ttl}`,
          ].join('\n')}\n`,
        );
      } catch (error) {
        process.stderr.write(
          `读取 QQ 内存失败：${error instanceof Error ? error.message : String(error)}\n`,
        );
        return 1;
      }
    }
    return 0;
  }

  if (values.check) {
    if (!values.account) {
      process.stderr.write('--check 需要 --account <uin>\n');
      return 2;
    }
    process.stdout.write(
      `${describeBot({ config: { account: { uin: values.account } }, native })}\n`,
    );
    return 0;
  }

  const vault = new FileCredentialVault({ dir: defaultVaultDir() });

  if (values.sidecar) {
    if (!values.account) {
      process.stderr.write('--sidecar 需要 --account <uin>\n');
      return 2;
    }
    // 凭据只从控制通道拿；事件写回 stdout，日志走 stderr（stdout 是协议流）。
    const sidecarConfig = startupConfig(fileConfig, values.account);
    runSidecar({
      uin: values.account,
      native,
      vault,
      stdin: process.stdin,
      stdout: process.stdout,
      // sidecar 的 OneBot 配置来自启动参数，不走控制通道：一个 sidecar 一个账号，
      // 端口拓扑属于部署形态，不该由每次 login 决定。
      ...(sidecarConfig ? { config: sidecarConfig } : {}),
    });
    log.info('sidecar 已就绪，等待控制通道指令', { uin: values.account });
    return -1;
  }

  if (values.serve) {
    if (!values.account) {
      process.stderr.write('--serve 需要 --account <uin>\n');
      return 2;
    }
    const daemonConfig = startupConfig(fileConfig, values.account);
    const daemon = await runDaemon({
      uin: values.account,
      native,
      vault,
      logger: log,
      ...(daemonConfig ? { config: daemonConfig } : {}),
      ...(values.socket ? { socketPath: values.socket } : {}),
    });

    // 信号 → close：走 `bot.stop()` → `closeSession` → `UnRegister`，手机端才会
    // 摘掉「电脑在线」。客户端断开不走这条路（那只是没人看，不是下线）。
    const stop = (signal: string): void => {
      log.info('收到退出信号，开始下线', { signal });
      void daemon.close(signal);
    };
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      process.once(signal, () => stop(signal));
    }

    log.info('daemon 已上线，等待客户端', {
      uin: values.account,
      socket: daemon.socketPath,
    });
    return -1;
  }

  const qqDbPath = values['qq-db'] ?? process.env.WEQBOT_QQ_DB;
  // 配置文件里的手动路径只喂给控制台探测；bot 只认 `qq.dbPath`。
  const qqPaths = pickQqPaths(fileConfig?.qq);
  const baseConfig = mergeConfig({
    ...(fileConfig ? { file: fileConfig } : {}),
    ...(values.account ? { uin: values.account } : { uin: '' }),
    ...(qqDbPath ? { qqDbPath } : {}),
  });

  // 控制台的配置里没有 account：账号由登录页决定（单进程单账号）。
  const { account: _ignoredAccount, ...consoleConfig } = baseConfig;
  void _ignoredAccount;

  const webui = values['no-webui']
    ? undefined
    : await runWebUi({
        binding: loaded.binding,
        native,
        vault,
        config: consoleConfig,
        onebotByUin: fileConfig?.onebotByUin ?? {},
        ...(values.config ? { configPath: values.config } : {}),
        ...(qqDbPath ? { qqDbPath } : {}),
        ...(qqPaths ? { qqPaths } : {}),
        ...(values['webui-host'] ? { host: values['webui-host'] } : {}),
        ...(values['webui-port'] ? { port: Number(values['webui-port']) } : {}),
        ...(process.env.WEQBOT_WEBUI_TOKEN ? { token: process.env.WEQBOT_WEBUI_TOKEN } : {}),
        logger: log,
      });

  if (!values.account && !webui) {
    process.stderr.write('没有 --account，且指定了 --no-webui：无事可做\n\n');
    process.stderr.write(USAGE);
    return 2;
  }

  // 带 `--account` 时立即用这个账号上线；不带时停在登录页等用户选。
  if (values.account) {
    if (!webui) {
      // `--no-webui` 的直启路径：自己建 bot，不经过控制台。
      const bot = createBot({ config: baseConfig, native, vault, logger: log });
      const stop = (signal: string): void => {
        log.info('收到退出信号，开始下线', { signal });
        void bot.stop('closed').finally(() => process.exit(0));
      };
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
        process.once(signal, () => stop(signal));
      }
      await bot.start();
      log.info('bot 已上线', {
        uin: values.account,
        onebot: bot.onebot
          ? { port: bot.onebot.port, actions: bot.onebot.actions().length }
          : 'off',
      });
      return -1;
    }
    await webui.runtime.startAccount(values.account);
    log.info('bot 已上线', {
      uin: values.account,
      onebot: webui.runtime.currentBot?.onebot
        ? {
            port: webui.runtime.currentBot.onebot.port,
            actions: webui.runtime.currentBot.onebot.actions().length,
          }
        : 'off',
    });
  }

  /**
   * 优雅下线：`bot.stop()` 会走 `closeSession` → 发 `UnRegister`，服务端才会
   * 把这条会话摘掉。
   *
   * 三个信号都要接：`SIGINT`（Ctrl-C）、`SIGTERM`（systemd / docker / kill 默认）、
   * **`SIGHUP`（关终端窗口）**。SIGHUP 之前漏了 —— 在终端里直接关窗口时进程会
   * 被直接杀掉，`UnRegister` 根本发不出去，手机端会一直显示「电脑在线」。
   *
   * `SIGKILL` 接不住（内核直接回收），那种情况只能靠服务端心跳超时把会话摘掉。
   */
  const stop = (signal: string): void => {
    log.info('收到退出信号，开始下线', { signal });
    const closing = webui ? webui.close() : Promise.resolve();
    void closing.finally(() => process.exit(0));
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.once(signal, () => stop(signal));
  }

  return -1;
}

main(process.argv.slice(2)).then(
  (code) => {
    // -1 = 进程需要保持运行（sidecar / bot 主循环）。
    if (code >= 0) process.exit(code);
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
