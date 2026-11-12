/**
 * 绑定好 (native, target) 的协议客户端。
 *
 * 搬运进来的 spec 全都保持 `(nt, pid, spec, params)` 形状（为了能逐字复制），
 * 但业务代码不想每次把两者传来传去 —— 这一层就是那个「闭包」。
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
  /** 逃生口：直接发原始 SSO 包（调试 / 未建模的命令）。 */
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
