/**
 * 签名登记审计：给「这个平台还需要实测哪些命令」一个机器可查的答案。
 *
 * 为什么需要它：`SIGN_RULES` 里的策略是**按平台**的（`all` / `non-linux` /
 * `not-darwin` / 逐端声明），但「哪些结论是实测过的、哪些是推断的」这件事
 * 表本身表达不出来。Windows / macOS 拿到代码后，不应该靠翻注释和 git log
 * 去猜 —— 跑一条命令就该拿到清单。
 *
 * 判据（与 TODO 的实测记录保持一致）：
 *   - `evidence: 'measured'`  → 有真机观测，直接信任；
 *   - `evidence: 'inferred'`  → 从别的平台推断（例如 `non-linux` 的 macOS 一侧
 *     按 Windows 处理），**必须在本平台复测**；
 *   - 未登记 → 运行时会静默按「不签名」发包，最危险，优先级最高。
 */

import { SIGN_RULES, UNCONFIRMED_SIGN_COMMANDS, type SignRule } from './sign-policy';

export type Platform = NodeJS.Platform;

/**
 * 每条规则的证据等级。
 *
 * Linux 于 2026-11-13、Windows / macOS 于 2026-11-14 各有一批真机观测，
 * 但**绝大部分已登记规则仍是推断结论**。签名自验（P4.0）已取消，所以
 * `inferred` 不是待办，只是「这个结论来自别的平台」的事实标注；`missing`
 * 仍然是问题（运行时静默不签），新命令必须补登记。
 */
export interface SignEvidence {
  linux: 'measured' | 'inferred' | 'none';
  win32: 'measured' | 'inferred' | 'none';
  darwin: 'measured' | 'inferred' | 'none';
}

/**
 * 已知的实测覆盖范围（手工维护，与 TODO 的实测记录同源）。
 *
 * 新增实测后在这里登记 —— 这是**唯一**需要人工更新的地方，其余都由
 * `auditSignRules()` 推导。日期写进注释，便于判断结论是否过期。
 */
export const MEASURED_COMMANDS: Readonly<Record<string, ReadonlyArray<keyof SignEvidence>>> = {
  // 2026-11-13 Linux（QQ 3.2.35-54395），probe-sign 真机观测。
  // 同一命令若后来又补测了别的平台，把该平台追加进同一个数组（见文件末尾
  // 的 2026-11-14 块），不要重复建 key。
  'OidbSvcTrpcTcp.0xfd4_1': ['linux'],
  'OidbSvcTrpcTcp.0xfe5_2': ['linux'],
  'OidbSvcTrpcTcp.0xfe7_3': ['linux'],
  'OidbSvcTrpcTcp.0xfe7_4': ['linux'],
  'OidbSvcTrpcTcp.0xfe1_2': ['linux'],
  'OidbSvcTrpcTcp.0x126b_0': ['linux'],
  'OidbSvcTrpcTcp.0x912e_0': ['linux'],
  'OidbSvcTrpcTcp.0x912f_0': ['linux'],
  'OidbSvcTrpcTcp.0xd69_0': ['linux'],
  'OidbSvcTrpcTcp.0xd72_0': ['linux'],
  'OidbSvcTrpcTcp.0x9154_1': ['linux'],
  'OidbSvcTrpcTcp.0x9155_1': ['linux'],
  'OidbSvcTrpcTcp.0x496_0': ['linux'],
  'OidbSvcTrpcTcp.0x990_2': ['linux'],
  'OidbSvcTrpcTcp.0x93d2_1': ['linux'],
  'OidbSvcTrpcTcp.0x9407_1': ['linux'],
  'OidbSvcTrpcTcp.0x9427_0': ['linux'],
  'OidbSvcTrpcTcp.0x9164_2': ['linux'],
  'OidbSvcTrpcTcp.0x9c1c_2': ['linux'],
  'OidbSvcTrpcTcp.0x904_1': ['linux'],
  'OidbSvcTrpcTcp.0xef0_1': ['linux'],
  'OidbSvcTrpcTcp.0xf00_3': ['linux'],
  'OidbSvcTrpcTcp.0x8fc_3': ['linux'],
  'OidbSvcTrpcTcp.0x8a0_1': ['linux'],
  'OidbSvcTrpcTcp.0x1096_1': ['linux'],
  'OidbSvcTrpcTcp.0x89a_0': ['linux'],
  'OidbSvcTrpcTcp.0x89a_15': ['linux'],
  'OidbSvcTrpcTcp.0x1253_1': ['linux'],
  'OidbSvcTrpcTcp.0x8a7_0': ['linux'],
  'OidbSvcTrpcTcp.0x967c_0': ['linux'],
  'OidbSvcTrpcTcp.0x967d_0': ['linux'],
  'OidbSvcTrpcTcp.0x967e_0': ['linux'],
  'OidbSvcTrpcTcp.0x1097_1': ['linux'],
  'OidbSvcTrpcTcp.0x6d6_2': ['linux'],
  'OidbSvcTrpcTcp.0x6d6_3': ['linux'],
  'OidbSvcTrpcTcp.0x6d8_1': ['linux'],
  'OidbSvcTrpcTcp.0x102a_0': ['linux'],
  'OidbSvcTrpcTcp.0x102a_1': ['linux'],
  'OidbSvcTrpcTcp.0x7e5_104': ['linux'],
  'OidbSvcTrpcTcp.0x7ed_12': ['linux'],
  'OidbSvcTrpcTcp.0x9067_202': ['linux'],
  'OidbSvcTrpcTcp.0xcd4_1': ['linux'],
  'OidbSvcTrpcTcp.0xcde_2': ['linux'],
  'OidbSvcTrpcTcp.0x112e_1': ['linux'],
  'OidbSvcTrpcTcp.0xe07_0': ['linux'],
  'OidbSvcTrpcTcp.0xdc2_34': ['linux'],
  'OidbSvcTrpcTcp.0x112a_2': ['linux'],
  'OidbSvcTrpcTcp.0x1124_1': ['linux'],
  'OidbSvcTrpcTcp.0x1125_1': ['linux'],
  'OidbSvcTrpcTcp.0x1126_1': ['linux'],
  'OidbSvcTrpcTcp.0x5d6_6': ['linux'],
  'OidbSvcTrpcTcp.0x5d6_19': ['linux'],
  'OidbSvcTrpcTcp.0x10c0_2': ['linux'],
  'OidbSvcTrpcTcp.0x10c8_1': ['linux'],
  'OidbSvcTrpcTcp.0x9082_1': ['linux'],
  'OidbSvcTrpcTcp.0x9083_1': ['linux'],
  'OidbSvcTrpcTcp.0x9084_1': ['linux'],
  'OidbSvcTrpcTcp.0xed3_1': ['linux'],
  'OidbSvcTrpcTcp.0xeb7_1': ['linux'],

  // 2026-11-14 Windows（QQ 9.9.35）/ macOS 双端 probe-sign 真机观测，全部不签名。
  // 这批原先只在 UNCONFIRMED_SIGN_COMMANDS 里挂着「未实测」，运行时静默按不签名
  // 发包；实测确认后才敢写成 SIGN_RULES 的 sign: 'none'。
  'MQUpdateSvc_com_qq_ti.web.OidbSvc.0xeb1_1': ['win32', 'darwin'],
  'OidbSvc.0x4ff_9_IMCore': ['win32', 'darwin'],
  'OidbSvc.0xcf4': ['win32', 'darwin'],
  'OidbSvcTrpcTcp.0x10eb_1': ['win32', 'darwin'],
  'OidbSvcTrpcTcp.0x1290_0': ['win32', 'darwin'],
  'OidbSvcTrpcTcp.0x1291_0': ['win32', 'darwin'],
  'OidbSvcTrpcTcp.0x1292_0': ['win32', 'darwin'],
  'OidbSvcTrpcTcp.0x5d6_1': ['win32', 'darwin'],
  'OidbSvcTrpcTcp.0x5d6_18': ['win32', 'darwin'],
  'OidbSvcTrpcTcp.0x6d6_0': ['win32', 'darwin'],
  'OidbSvcTrpcTcp.0xf90_1': ['win32', 'darwin'],
  'OidbSvcTrpcTcp.0xf90_2': ['win32', 'darwin'],
  'OidbSvcTrpcTcp.0xf90_3': ['win32', 'darwin'],
  'pttTrans.TransC2CPttReq': ['win32', 'darwin'],
  'pttTrans.TransGroupPttReq': ['win32', 'darwin'],
  'trpc.qqrtc.av_appsvr.AvAppsvr.SsoAcceptInvite': ['win32', 'darwin'],
  'trpc.qqrtc.mav_appsvr.MavAppsvr.SsoDeleteUser': ['win32', 'darwin'],
  'trpc.qqrtc.mav_appsvr.MavAppsvr.SsoEnterRoom': ['win32', 'darwin'],
  // 这两条 Linux 侧早前已实测（见上），三端证据齐全。
  'OidbSvcTrpcTcp.0x1255_0': ['linux', 'win32', 'darwin'],
  'OidbSvcTrpcTcp.0xf16_1': ['linux', 'win32', 'darwin'],

  // 2026-11-15 Linux（QQ 3.2.35-54395）/ 2026-11-16 Windows（QQ 9.9.35-52892）
  // probe-sign 实测，P8 新增的 8 条命令。正对照 `0x88d_0` 通过（它自己签名），
  // 命中、0 丢帧 —— 因此「无 tag 24」是真的不签名。
  // ⚠️ 正文是占位：签名决策看命令字，但真实业务正文未验收。
  // macOS 待测；补测后把 'darwin' 追加进对应数组。
  'OidbSvcTrpcTcp.0x88d_0': ['linux', 'win32'], // 签（两端）
  'OidbSvcTrpcTcp.0x929d_0': ['linux', 'win32'], // 不签
  'OidbSvcTrpcTcp.0x6d9_0': ['linux', 'win32'], // 不签
  'OidbSvcTrpcTcp.0x93d4_1': ['linux', 'win32'], // 不签
  'OidbSvcTrpcTcp.0x12a9_200': ['linux', 'win32'], // Linux 不签 / Windows 签
  'OidbSvcTrpcTcp.0x9060_3': ['linux', 'win32'], // 不签
  'LightAppSvc.mini_app_share.AdaptShareInfo': ['linux', 'win32'], // 不签
  'MQUpdateSvc_com_qq_ti.web.OidbSvc.0xe17_0': ['linux', 'win32'], // 不签
};

export interface SignAuditEntry {
  /** wire 命令。 */
  command: string;
  /** 当前登记的策略（未登记为 `undefined`）。 */
  rule: SignRule | undefined;
  /** 该平台是否会被要求签名。 */
  needsSign: boolean | undefined;
  /** 证据等级。 */
  evidence: 'measured' | 'inferred' | 'none';
  /** 优先级：`missing` 最危险（静默不签）。 */
  priority: 'missing' | 'inferred';
}

export interface SignAuditOptions {
  /** 待审计的命令；不传则审计整张表。 */
  commands?: readonly string[];
  platform?: Platform;
}

function evidenceFor(command: string, platform: Platform): SignAuditEntry['evidence'] {
  const measured = MEASURED_COMMANDS[command];
  if (measured?.includes(platform as keyof SignEvidence)) return 'measured';
  return Object.hasOwn(SIGN_RULES, command) ? 'inferred' : 'none';
}

function needsSignOn(rule: SignRule, platform: Platform): boolean {
  if (typeof rule.sign === 'object') {
    if (platform === 'win32') return rule.sign.win32;
    if (platform === 'darwin') return rule.sign.darwin;
    return rule.sign.linux;
  }
  if (rule.sign === 'all') return true;
  if (rule.sign === 'none') return false;
  if (rule.sign === 'non-linux') return platform !== 'linux';
  return platform !== 'darwin'; // not-darwin
}

/**
 * 生成某平台的待测清单。
 *
 * 只返回需要**复测**的（`inferred` 或 `missing`）：已实测的、以及本平台
 * 明确不签名且证据充分的，不占版面。
 */
export function auditSignRules(options: SignAuditOptions = {}): SignAuditEntry[] {
  const platform = options.platform ?? process.platform;
  const commands =
    options.commands ??
    [...new Set([...Object.keys(SIGN_RULES), ...Object.keys(UNCONFIRMED_SIGN_COMMANDS)])].sort();

  const entries: SignAuditEntry[] = [];
  for (const command of commands) {
    const rule = (SIGN_RULES as Record<string, SignRule>)[command];
    const evidence = evidenceFor(command, platform);
    if (evidence === 'measured') continue;

    entries.push({
      command,
      rule,
      needsSign: rule ? needsSignOn(rule, platform) : undefined,
      evidence,
      priority: evidence === 'none' ? 'missing' : 'inferred',
    });
  }

  // missing 优先，其次按命令名排序，便于逐条勾。
  return entries.sort((left, right) => {
    if (left.priority !== right.priority) return left.priority === 'missing' ? -1 : 1;
    return left.command.localeCompare(right.command);
  });
}

/** 人类可读的清单（CLI 输出用）。 */
export function formatSignAudit(entries: readonly SignAuditEntry[], platform: Platform): string {
  const missing = entries.filter((entry) => entry.priority === 'missing');
  const inferred = entries.filter((entry) => entry.priority === 'inferred');
  const lines: string[] = [
    `签名实测清单 · ${platform}`,
    `  未登记（运行时会静默不签，优先测）：${missing.length} 条`,
    `  有登记但本平台未实测（结论是推断的）：${inferred.length} 条`,
    '',
  ];

  if (missing.length > 0) {
    lines.push('## 未登记');
    for (const entry of missing) lines.push(`  ${entry.command}`);
    lines.push('');
  }
  if (inferred.length > 0) {
    lines.push('## 本平台未实测');
    for (const entry of inferred) {
      const needsSign =
        entry.needsSign === undefined ? '?' : entry.needsSign ? '需要签名' : '不签名';
      lines.push(`  ${entry.command.padEnd(46)} 当前登记：${needsSign}`);
    }
  }
  return lines.join('\n');
}
