/**
 * Packet transport —— 从 `WeQ/packages/protocol/src/transport.ts` 搬运，只改两处：
 *
 *   1. `NtHelperBinding` → {@link NativePort}（结构类型，由宿主注入）；
 *   2. `pid: number` → {@link SessionId}（native 分配的会话句柄，不再是进程 pid）。
 *
 * 其余逻辑（中央签名表查表、override 只给调试用、原生签名优先/TS 兜底）逐行未动。
 *
 * **为什么在 protocol 而不是 wire**：签名策略是协议知识，不是传输契约。放在 wire
 * 会让 wire 依赖一张协议表；放在这里，wire 只剩「怎么发字节」。2026-11-12 之前
 * wire 里有一份空表的同名模块，protocol 的 spec 走的是那份 —— 所有命令都会按
 * 默认值发包，是静默错签的隐患，已删除。
 */

import { WeqBotError } from '@weqbot/common';
import type { NativePort, SessionId } from '@weqbot/wire';
import { signRedBagRequest as signRedBagRequestTs } from './redbag/sign';
import { oidbCommand, resolveSign, type ResolvedSign } from './sign-policy';

/** 本层用到的最小原生切片，方便测试传桩。 */
export type PacketNative = Pick<NativePort, 'sendPacket' | 'sendOidbPacket'>;
export type OidbNative = Pick<NativePort, 'sendOidbPacket'>;
export type TrpcNative = Pick<NativePort, 'sendPacket'>;

/**
 * 红包签名出口。
 *
 * 原生导出优先（2026-09-30 才进 nt_helper），旧产物没有它 —— 那种情况退到 TS
 * 侧同一算法（`./redbag/sign`，固定向量与原生逐字节一致）。所以这里是**可选**
 * 能力，不能放进 `NativePort` 的必选集。
 */
export interface RedBagSignNative {
  signRedBagRequest?(input: Uint8Array): Uint8Array;
}

export interface OidbRequest {
  /** OIDB 命令，例如 0x9067。 */
  command: number;
  /** OIDB 子命令，例如 202。 */
  subCommand: number;
  /** protobuf 编码后的请求体。 */
  body: Uint8Array;
  /** 用 UIN 形态（reserved=1）。默认 false。 */
  isUid?: boolean;
}

/**
 * 按命令查表得到要传给 native 的签名参数。
 *
 * `override` 只给调试开关用；业务代码一律不要传，否则会绕过中央表。
 */
function signArgs(cmd: string, override?: Partial<ResolvedSign>): ResolvedSign {
  return override ? { ...resolveSign(cmd), ...override } : resolveSign(cmd);
}

/** 会话句柄由 native 从 1 开始分配；0 / 负数 / 小数一律视为调用方 bug。 */
function assertSessionId(sessionId: SessionId, who: string): void {
  if (!Number.isInteger(sessionId) || sessionId < 1) {
    throw new WeqBotError('UNKNOWN', `${who}: 非法会话 ID ${sessionId}`);
  }
}

/**
 * 发一条 OIDB 请求，返回**内层**回包体。
 *
 * 签名策略按 `OidbSvcTrpcTcp.0x<command>_<subCommand>` 查中央表。
 */
export async function sendOidb(
  nt: OidbNative,
  sessionId: SessionId,
  req: OidbRequest,
  override?: Partial<ResolvedSign>,
): Promise<Uint8Array> {
  assertSessionId(sessionId, 'sendOidb');
  const { needSign, mode: signMode } = signArgs(oidbCommand(req.command, req.subCommand), override);
  const reply = await nt.sendOidbPacket(
    sessionId,
    req.command,
    req.subCommand,
    // 包成 Buffer：native 侧与宿主侧（WeQ 的调用记录 / 断言）都按 Buffer 语义使用。
    Buffer.from(req.body),
    req.isUid ?? false,
    needSign,
    signMode,
  );
  return new Uint8Array(reply);
}

/**
 * 发一条裸 SSO 包（`cmd` 例如 trpc 服务名），返回原始回包体。
 *
 * 签名策略按 `cmd` 原样查中央表。
 */
export async function sendPacket(
  nt: TrpcNative,
  sessionId: SessionId,
  cmd: string,
  body: Uint8Array,
  override?: Partial<ResolvedSign>,
): Promise<Uint8Array> {
  assertSessionId(sessionId, 'sendPacket');
  const { needSign, mode: signMode } = signArgs(cmd, override);
  const reply = await nt.sendPacket(sessionId, cmd, Buffer.from(body), needSign, signMode);
  return new Uint8Array(reply);
}

/** 给红包请求算 16 字节明文 `f101`。 */
export function signRedBagRequest(nt: RedBagSignNative, signInput: Uint8Array): Uint8Array {
  if (typeof nt?.signRedBagRequest === 'function') {
    return new Uint8Array(nt.signRedBagRequest(signInput));
  }
  return signRedBagRequestTs(signInput);
}
