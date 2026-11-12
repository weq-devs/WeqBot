/**
 * 签名策略：**以 wire 命令为键的中央表**。
 *
 * 表本身在 P1 从 `WeQ/packages/protocol/src/sign-policy.ts` 逐条搬运（连同
 * `WeQ/docs/develop/sign-policy-20261109.md` 的观测记录）。这里只放**形状**，
 * 不放猜测值 —— 编造条目比空表更危险：空表会让所有命令走「默认签」，
 * 而错误的表会让个别命令静默发错。
 *
 * 搬运时的硬规则（照抄 WeQ 的注释，防止后来人「优化」掉）：
 *   - 三端签名集合不同，**禁止取并集**：多带 `SecInfo` 曾触发风控；
 *   - 键就是抓包里的那个字符串，能逐条比对；
 *   - `mode2: true` 表示完整签名（VM mode = 2），缺省精简签名（mode = 3）。
 */

export type SignRuleSwitch = 'all' | 'none' | 'non-linux' | 'not-darwin';

export interface PerPlatform {
  linux: boolean;
  win32: boolean;
  darwin: boolean;
}

export interface SignRule {
  sign: SignRuleSwitch | PerPlatform;
  mode2?: boolean;
}

/** wire 命令 → 规则。P1 搬运后应覆盖 `@weq/protocol` 支持的全部命令。 */
export const SIGN_RULES: Record<string, SignRule> = {};

/** 已知需要签名、但尚未在抓包里确认模式的命令（诊断用，不参与决策）。 */
export const UNCONFIRMED_SIGN_COMMANDS: readonly string[] = [];

export type Platform = 'linux' | 'win32' | 'darwin';

export interface ResolveOptions {
  platform?: Platform;
}

function platformOf(): Platform {
  switch (process.platform) {
    case 'win32':
      return 'win32';
    case 'darwin':
      return 'darwin';
    default:
      return 'linux';
  }
}

/**
 * 查表得到 `(needSign, mode)`。
 *
 * 未登记的命令按「签」处理，并交给调用方的日志层告警 —— **默认不签**会让一批
 * 命令被服务端静默丢弃，更难排查。
 */
export function resolveSign(
  cmd: string,
  options: ResolveOptions = {},
): { needSign: boolean; mode: 2 | 3 } {
  const rule = SIGN_RULES[cmd];
  if (!rule) return { needSign: true, mode: 3 };

  const platform = options.platform ?? platformOf();
  const switchValue = rule.sign;
  const needSign =
    typeof switchValue === 'string'
      ? switchValue === 'all'
        ? true
        : switchValue === 'none'
          ? false
          : switchValue === 'non-linux'
            ? platform !== 'linux'
            : /* not-darwin */ platform !== 'darwin'
      : switchValue[platform];

  // Linux 的 VM ABI 没有 mode 参数，native 侧固定按 3 处理。
  return { needSign, mode: rule.mode2 && platform !== 'linux' ? 2 : 3 };
}

/** OIDB 命令名，与 `sendOidbPacket` 的 (command, subCommand) 一一对应。 */
export function oidbCommand(command: number, subCommand: number): string {
  return `OidbSvcTrpcTcp.0x${command.toString(16)}_${subCommand}`;
}
