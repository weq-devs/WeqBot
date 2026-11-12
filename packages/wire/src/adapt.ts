/**
 * 把宿主的原生绑定适配成 {@link NativePort}。
 *
 * 两个真实来源：
 *   - WeQ desktop：`platform.native`（`@weq/native` 的 `NtHelperBinding`）；
 *   - 独立进程：`@weqbot/node` 的 slim 加载器（形状刻意与 WeQ 那份一致）。
 *
 * 适配层只做两件事：**字节类型归一**（`Uint8Array` ↔ `Buffer`）和**保留 this**。
 * 它不做版本判断，能力探测交给 `capabilities.ts`；缺失的方法保持 `undefined`，
 * 不补桩，这样探测看到的是真实情况。
 */

import type {
  NativeBuildInfo,
  NativePort,
  OnlineOpenOptions,
  OnlineSession,
  OnlineStatusEvent,
  PushFrame,
  QuickLoginOptions,
  QuickLoginResult,
} from './types';

/**
 * 宿主给的原始绑定。
 *
 * 形状对齐 `nt_helper` 的 napi 导出：字节参数是 `Buffer`（napi 的 `Buffer` 参数
 * 不接受裸 `Uint8Array`），返回也是 `Buffer`。
 */
export interface RawNativeBinding {
  sendPacket?(
    target: number,
    cmd: string,
    body: Buffer,
    needSign?: boolean | null,
    mode?: number | null,
  ): Promise<Buffer>;

  sendOidbPacket?(
    target: number,
    command: number,
    subCommand: number,
    body: Buffer,
    isUid: boolean,
    needSign: boolean,
    mode?: number | null,
  ): Promise<Buffer>;

  setSsoSession?(
    pid: number,
    session: unknown,
    wrapperPath?: string | null,
    signCoreRva?: number | null,
    vmRva?: number | null,
  ): Promise<void>;
  clearSsoSession?(pid: number): Promise<boolean>;
  hasSsoSession?(pid: number): Promise<boolean>;

  quickLogin?(
    options: QuickLoginOptions,
    onEvent?: (error: Error | null, event: unknown) => unknown,
  ): Promise<QuickLoginResult>;
  openOnline?(options: OnlineOpenOptions): Promise<OnlineSession>;
  closeOnline?(handle: number, reason?: string): Promise<void>;
  attachPushSink?(
    handle: number,
    sink: (error: Error | null, frame: PushFrame) => void,
  ): Promise<() => void>;
  attachStatusSink?(handle: number, sink: (event: OnlineStatusEvent) => void): Promise<() => void>;

  warmupSigner?(wrapperPath: string): Promise<{ signCoreRva: number; vmRva: number }>;
  getBuildInfo?(): NativeBuildInfo;
}

export function adaptNativeBinding(raw: RawNativeBinding): NativePort {
  const adapted: Partial<NativePort> = {};

  if (raw.sendPacket) {
    const call = raw.sendPacket.bind(raw);
    adapted.sendPacket = async (target, cmd, body, needSign, mode) =>
      new Uint8Array(await call(target, cmd, Buffer.from(body), needSign, mode));
  }

  if (raw.sendOidbPacket) {
    const call = raw.sendOidbPacket.bind(raw);
    adapted.sendOidbPacket = async (target, command, subCommand, body, isUid, needSign, mode) =>
      new Uint8Array(
        await call(target, command, subCommand, Buffer.from(body), isUid, needSign, mode),
      );
  }

  if (raw.setSsoSession) {
    const call = raw.setSsoSession.bind(raw);
    adapted.setSsoSession = (pid, session, wrapperPath, signCoreRva, vmRva) =>
      call(pid, session, wrapperPath, signCoreRva, vmRva);
  }
  if (raw.clearSsoSession) {
    const call = raw.clearSsoSession.bind(raw);
    adapted.clearSsoSession = (pid) => call(pid);
  }
  if (raw.hasSsoSession) {
    const call = raw.hasSsoSession.bind(raw);
    adapted.hasSsoSession = (pid) => call(pid);
  }

  if (raw.quickLogin) {
    const call = raw.quickLogin.bind(raw);
    adapted.quickLogin = (options, onEvent) => call(options, onEvent);
  }
  if (raw.openOnline) {
    const call = raw.openOnline.bind(raw);
    adapted.openOnline = (options) => call(options);
  }
  if (raw.closeOnline) {
    const call = raw.closeOnline.bind(raw);
    adapted.closeOnline = (handle, reason) => call(handle, reason);
  }
  if (raw.attachPushSink) {
    const call = raw.attachPushSink.bind(raw);
    adapted.attachPushSink = (handle, sink) => call(handle, (_error, frame) => sink(frame));
  }
  if (raw.attachStatusSink) {
    const call = raw.attachStatusSink.bind(raw);
    adapted.attachStatusSink = (handle, sink) => call(handle, sink);
  }
  if (raw.warmupSigner) {
    const call = raw.warmupSigner.bind(raw);
    adapted.warmupSigner = (wrapperPath) => call(wrapperPath);
  }
  if (raw.getBuildInfo) {
    const call = raw.getBuildInfo.bind(raw);
    adapted.getBuildInfo = () => call();
  }

  return adapted as NativePort;
}
