#!/usr/bin/env node
/**
 * 独立进程入口（骨架）。
 *
 * 现在只做两件真事：加载 slim native、打印能力报告。
 * 完整的启动流程（vault → quickLogin → openSession → OneBot）在 P3/P4 落地，
 * 见 `TODO.md`「阶段计划」。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createBot, describeBot } from '@weqbot/bot';
import { createLogger } from '@weqbot/common';
import { FileCredentialVault } from '@weqbot/session';
import { adaptNativeBinding, inspectNative } from '@weqbot/wire';
import { ConfigError, loadConfigFile, mergeConfig } from './config';
import { loadNative } from './loader';
import { runSidecar } from './sidecar';
import { runWebUi } from './webui';

/** 独立进程的默认凭据目录；`WEQBOT_VAULT_DIR` 可覆盖（测试 / 多实例）。 */
function defaultVaultDir(): string {
  return process.env.WEQBOT_VAULT_DIR ?? join(homedir(), '.weqbot', 'accounts');
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

选项:
  --account <uin>      账号 uin；不给则只起控制台
  --native-dir <dir>   原生组件目录（默认 $WEQBOT_NATIVE_DIR 或 ./native/<platform>-<arch>）
  --qq-db <path>       账号 nt_msg.db 绝对路径（mode2 预检 isQqLoggedIn 用；
                       也可用 $WEQBOT_QQ_DB）
  --config <path>      JSON 配置：native / qq / session / secToken / onebot / log
                       （不含凭据；字段见 packages/node/config.example.json）
  --webui-port <port>  控制台端口（默认 6099，只听 127.0.0.1）
  --webui-host <host>  控制台监听地址（默认 127.0.0.1；非回环会告警）
  --no-webui           不启动控制台
  --qq-pid <pid>       只与 --print-capabilities 连用：诊断 QQ 进程的会话物料
                       （需要 root / CAP_SYS_PTRACE）
  --check              自检模式
  --sidecar            desktop 拉起的托管模式（NDJSON over stdio，见 @weqbot/control）
  --verbose            打开 debug 日志
  -h, --help           显示本帮助

环境变量:
  WEQBOT_WEBUI_TOKEN   固定控制台令牌（默认每次启动随机生成并打印）
`;

async function main(argv: string[]): Promise<number> {
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
      'print-capabilities': { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
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

  const log = createLogger('cli', { level: values.verbose ? 'debug' : 'info' });
  const loaded = loadNative({ ...(values['native-dir'] ? { dir: values['native-dir'] } : {}) });
  const native = adaptNativeBinding(loaded.binding);
  const capabilities = inspectNative(native);

  log.info('原生组件已加载', {
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
    runSidecar({
      uin: values.account,
      native,
      vault,
      stdin: process.stdin,
      stdout: process.stdout,
      // sidecar 的 OneBot 配置来自启动参数，不走控制通道：一个 sidecar 一个账号，
      // 端口拓扑属于部署形态，不该由每次 login 决定。
      ...(fileConfig ? { config: fileConfig } : {}),
    });
    log.info('sidecar 已就绪，等待控制通道指令', { uin: values.account });
    return -1;
  }

  const qqDbPath = values['qq-db'] ?? process.env.WEQBOT_QQ_DB;
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
        ...(values.config ? { configPath: values.config } : {}),
        ...(qqDbPath ? { qqDbPath } : {}),
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
      bot.events.on('state', (change) => log.info('状态', change));
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
  } else {
    log.info('未指定 --account：控制台等待在登录页选择账号');
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
