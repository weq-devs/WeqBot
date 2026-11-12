/**
 * ⚠️ **上游没有这个文件**（`WeQ/packages/protocol/src/` 里不存在），是本仓库新增的门面。
 *
 * 搬运进来的 spec 全部保持 `(nt, target, spec, params)` 形状 —— 这是为了能逐字复制。
 * 但业务代码每次都要把 native 与 target 传一遍很啰嗦，这一层就是那个闭包。
 *
 * 它不含任何协议知识：没查表、没编解码、没网络。要做的事都能用下面两行写出来。
 */

import type { NativePort, SsoTarget } from '@weqbot/wire';
import { invokeOidb, invokeTrpc, type OidbSpec, type TrpcSpec } from './oidb/invoke';
import { sendPacket } from './transport';

export interface ProtocolClientOptions {
  native: NativePort;
  target: SsoTarget;
}

export interface ProtocolClient {
  readonly native: NativePort;
  readonly target: SsoTarget;
  oidb<TParams, TResult>(spec: OidbSpec<TParams, TResult>, params: TParams): Promise<TResult>;
  trpc<TParams, TResult>(spec: TrpcSpec<TParams, TResult>, params: TParams): Promise<TResult>;
  /** 逃生口：直接发裸 SSO 包（调试 / 尚未建模的命令）。 */
  raw(cmd: string, body: Uint8Array): Promise<Uint8Array>;
}

export function createProtocolClient(options: ProtocolClientOptions): ProtocolClient {
  const { native, target } = options;
  return {
    native,
    target,
    oidb: (spec, params) => invokeOidb(native, target, spec, params),
    trpc: (spec, params) => invokeTrpc(native, target, spec, params),
    raw: (cmd, body) => sendPacket(native, target, cmd, body),
  };
}
