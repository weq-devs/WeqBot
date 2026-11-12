/**
 * OIDB / trpc 分发 —— 从 `WeQ/packages/protocol/src/oidb/invoke.ts` 搬运，
 * 只有 `nt`/`pid` 两个参数的类型换了名字。逻辑一行没动。
 *
 * OIDB 信封（command/subCommand + error_code 检查）在 native 侧处理，所以 spec
 * 只描述**内层** req/resp body。
 */

import { decode, encode, type ProtoMessage } from '../protobuf';
import type { NativePort, SsoTarget } from '@weqbot/wire';
import { sendOidb, sendPacket } from '../transport';

export interface OidbSpec<TParams, TResult> {
  command: number;
  subCommand?: number;
  /** 从参数动态解析 sub-command（0x9082：1 = 贴表情，2 = 撤回）。 */
  resolveSubCommand?: (params: TParams) => number;
  uinForm?: boolean;
  reqSchema: ProtoMessage;
  respSchema: ProtoMessage;
  /** 同一字段有多种已确认 wire 形态时，由具体协议合并解码。 */
  decodeResponseBody?: (bytes: Uint8Array) => Record<string, unknown>;
  serialize(params: TParams): Record<string, unknown>;
  deserialize(body: Record<string, unknown>): TResult;
}

export async function invokeOidb<TParams, TResult>(
  nt: NativePort,
  target: SsoTarget,
  spec: OidbSpec<TParams, TResult>,
  params: TParams,
): Promise<TResult> {
  const subCommand = spec.resolveSubCommand ? spec.resolveSubCommand(params) : spec.subCommand;
  if (subCommand === undefined) {
    throw new Error(
      `OIDB spec 0x${spec.command.toString(16)} 既没有 subCommand 也没有 resolveSubCommand`,
    );
  }
  const reqBytes = encode(spec.reqSchema, spec.serialize(params));
  const respBytes = await sendOidb(nt, target, {
    command: spec.command,
    subCommand,
    body: reqBytes,
    isUid: spec.uinForm ?? false,
  });
  return spec.deserialize(
    spec.decodeResponseBody
      ? spec.decodeResponseBody(respBytes)
      : decode(spec.respSchema, respBytes),
  );
}

export interface TrpcSpec<TParams, TResult> {
  cmd: string;
  reqSchema: ProtoMessage;
  respSchema: ProtoMessage;
  serialize(params: TParams): Record<string, unknown>;
  /** 自定义请求体编码（运行时 schema 表达不了的 wire 形态，如 fixed32）。 */
  encodeRequest?(params: TParams): Uint8Array;
  deserialize(body: Record<string, unknown>): TResult;
  /** 直接用原始回包字节解析，跳过 schema。 */
  decodeResponse?(bytes: Uint8Array): TResult;
}

export async function invokeTrpc<TParams, TResult>(
  nt: NativePort,
  target: SsoTarget,
  spec: TrpcSpec<TParams, TResult>,
  params: TParams,
): Promise<TResult> {
  const reqBytes = spec.encodeRequest
    ? spec.encodeRequest(params)
    : encode(spec.reqSchema, spec.serialize(params));
  const respBytes = await sendPacket(nt, target, spec.cmd, reqBytes);
  return spec.decodeResponse
    ? spec.decodeResponse(respBytes)
    : spec.deserialize(decode(spec.respSchema, respBytes));
}
