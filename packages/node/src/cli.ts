#!/usr/bin/env node
/**
 * 独立进程入口（骨架）。
 *
 * 现在只做两件真事：加载 slim native、打印能力报告。
 * 完整的启动流程（vault → quickLogin → openSession → OneBot）在 P3/P4 落地，
 * 见 `TODO.md`「阶段计划」。
 */

import { parseArgs } from 'node:util';
import { createLogger, notImplemented } from '@weqbot/common';
import { adaptNativeBinding, inspectNative } from '@weqbot/wire';
import { describeBot } from '@weqbot/bot';
import { loadNative } from './loader';

const USAGE = `weqbot — 独立 QQ bot（mode2 自建上线）

用法:
  weqbot --account <uin>            启动 bot（P3 落地）
  weqbot --account <uin> --check    只做 native 自检，不连网
  weqbot --print-capabilities       打印原生组件能力
  weqbot --sidecar --account <uin>  desktop 托管模式：控制通道走 stdio（P3 落地）

选项:
  --account <uin>      账号 uin
  --native-dir <dir>   原生组件目录（默认 $WEQBOT_NATIVE_DIR 或 ./native/<platform>-<arch>）
  --config <path>      配置文件（P3 落地）
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

  if (values.sidecar) {
    // P3 起：ControlLineDecoder(stdin) → login/shutdown 分派；事件写回 stdout。
    // 凭据只从控制通道拿，不读自己的 vault（WeQ 场景由宿主持有）。
    throw notImplemented('sidecar 控制通道');
  }

  // P3 起：CredentialVault → createBot → start() → OneBot adapter。
  throw notImplemented('独立启动流程（vault / OneBot 适配）');
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
