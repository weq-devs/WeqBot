/**
 * 发包包装 —— 与 `WeQ/packages/protocol/src/transport.ts` **同形**，只换了两处：
 *
 *   1. `NtHelperBinding` → {@link NativePort}（结构类型，宿主注入）；
 *   2. `pid: number` → {@link SsoTarget}（pid 或 mode2 句柄，同一命名空间）。
 *
 * 保持同形是硬要求：`@weq/protocol` 的 161 个 spec 文件要能逐字搬过来，
 * 只在 import 路径上换个包名。任何「顺手重构」都会让搬运成本从复制粘贴变成翻译。
 */

import { WeqBotError } from '@weqbot/common';
import { oidbCommand, resolveSign } from './sign-policy';
import { isOnlineTarget, type NativePort, type ResolvedSign, type SsoTarget } from './types';

/** 本层用到的最小原生切片，方便测试传桩。 */
export type PacketNative = Pick<NativePort, 'sendPacket' | 'sendOidbPacket'>;
export type OidbNative = Pick<NativePort, 'sendOidbPacket'>;
export type TrpcNative = Pick<NativePort, 'sendPacket'>;

export interface OidbRequest {
  command: number;
  subCommand: number;
  body: Uint8Array;
  /** 用 UIN 形态（reserved=1）。默认 false。 */
  isUid?: boolean;
}

/**
 * `override` 只给调试脚本用；业务代码一律不要传，否则会绕过中央签名表。
 */
function signArgs(cmd: string, override?: Partial<ResolvedSign>): ResolvedSign {
  return override ? { ...resolveSign(cmd), ...override } : resolveSign(cmd);
}

function assertTarget(target: SsoTarget, who: string): void {
  if (!Number.isInteger(target) || target < 0) {
    throw new WeqBotError('UNKNOWN', `${who}: 非法 SSO 目标 ${target}`);
  }
}

export async function sendOidb(
  nt: OidbNative,
  target: SsoTarget,
  req: OidbRequest,
  override?: Partial<ResolvedSign>,
): Promise<Uint8Array> {
  assertTarget(target, 'sendOidb');
  const { needSign, mode } = signArgs(oidbCommand(req.command, req.subCommand), override);
  const reply = await nt.sendOidbPacket(
    target,
    req.command,
    req.subCommand,
    Buffer.from(req.body),
    req.isUid ?? false,
    needSign,
    mode,
  );
  return new Uint8Array(reply);
}

export async function sendPacket(
  nt: TrpcNative,
  target: SsoTarget,
  cmd: string,
  body: Uint8Array,
  override?: Partial<ResolvedSign>,
): Promise<Uint8Array> {
  assertTarget(target, 'sendPacket');
  const { needSign, mode } = signArgs(cmd, override);
  const reply = await nt.sendPacket(target, cmd, Buffer.from(body), needSign, mode);
  return new Uint8Array(reply);
}

export { isOnlineTarget };
