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
import { loadNative } from './loader';
import { runSidecar } from './sidecar';

/** 独立进程的默认凭据目录；`WEQBOT_VAULT_DIR` 可覆盖（测试 / 多实例）。 */
function defaultVaultDir(): string {
  return process.env.WEQBOT_VAULT_DIR ?? join(homedir(), '.weqbot', 'accounts');
}

const USAGE = `weqbot — 独立 QQ bot（mode2 自建上线）

用法:
  weqbot --account <uin>            启动 bot（P3 落地）
  weqbot --account <uin> --check    只做 native 自检，不连网
  weqbot --print-capabilities       打印原生组件能力
  weqbot --print-capabilities --qq-pid <pid> --account <uin>
                                    额外打印从 QQ 内存读到的 secToken 来源与 TTL
  weqbot --sidecar --account <uin>  desktop 托管模式：控制通道走 stdio（P3 落地）

选项:
  --account <uin>      账号 uin
  --native-dir <dir>   原生组件目录（默认 $WEQBOT_NATIVE_DIR 或 ./native/<platform>-<arch>）
  --qq-db <path>       账号 nt_msg.db 绝对路径（mode2 预检 isQqLoggedIn 用；
                       也可用 $WEQBOT_QQ_DB）
  --config <path>      配置文件（P3 落地）
  --qq-pid <pid>       只与 --print-capabilities 连用：诊断 QQ 进程的会话物料
                       （需要 root / CAP_SYS_PTRACE）
  --check              自检模式
  --sidecar            desktop 拉起的托管模式（NDJSON over stdio，见 @weqbot/control）
  --verbose            打开 debug 日志
  -h, --help           显示本帮助
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

  if (!values.account) {
    process.stderr.write('缺少 --account <uin>\n\n');
    process.stderr.write(USAGE);
    return 2;
  }

  process.stdout.write(
    `${describeBot({ config: { account: { uin: values.account } }, native })}\n`,
  );

  if (values.check) return 0;

  const vault = new FileCredentialVault({ dir: defaultVaultDir() });

  if (values.sidecar) {
    // 凭据只从控制通道拿；事件写回 stdout，日志走 stderr（stdout 是协议流）。
    runSidecar({
      uin: values.account,
      native,
      vault,
      stdin: process.stdin,
      stdout: process.stdout,
    });
    log.info('sidecar 已就绪，等待控制通道指令', { uin: values.account });
    return -1;
  }

  const qqDbPath = values['qq-db'] ?? process.env.WEQBOT_QQ_DB;
  const bot = createBot({
    config: {
      account: { uin: values.account },
      ...(qqDbPath ? { qq: { dbPath: qqDbPath } } : {}),
    },
    native,
    vault,
    logger: log,
  });
  bot.events.on('state', (change) => log.info('状态', change));
  bot.events.on('message', (message) =>
    log.info('消息', {
      scene: message.scene,
      peer: message.peer.id,
      sender: message.sender.id,
      elements: message.elements.length,
      dress: message.dress,
    }),
  );
  bot.events.on('notice', (notice) => log.info('通知', { kind: notice.kind }));
  bot.events.on('event', (event) => {
    if (event.type === 'error') log.error(event.error.message, { code: event.error.code });
  });

  const stop = (): void => {
    void bot.stop('closed').finally(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  await bot.start();
  log.info('bot 已上线（OneBot 适配在 P4）', { uin: values.account });
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
