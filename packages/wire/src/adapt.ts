/**
 * 把宿主的原生绑定适配成 {@link NativePort}。
 *
 * 两个真实来源：
 *   - WeQ desktop：`platform.native.ntHelper`（`@weq/native` 的 `NtHelperBinding`）；
 *   - 独立进程：`@weqbot/node` 的 slim 加载器（形状刻意与 WeQ 那份一致）。
 *
 * 适配层只做两件事：**字节类型归一**（`Uint8Array` → `Buffer`）和**保留 this**。
 * 它不做版本判断，能力探测交给 `capabilities.ts`；缺失的方法保持 `undefined`，
 * 不补桩，这样探测看到的是真实情况。
 */

import type {
  DeviceProfile,
  NativeBuildInfo,
  NativePort,
  OpenedSession,
  PushFrame,
  QuickLoginOptions,
  QuickLoginResult,
  SessionId,
  SessionInfo,
  SessionStatusEvent,
  SsoSessionConfig,
} from './types';

/** napi 的 `Buffer` 参数不接受裸 `Uint8Array`，进原生前统一转换。 */
interface RawSsoSessionConfig extends Omit<SsoSessionConfig, 'a2' | 'd2' | 'd2Key'> {
  a2: Buffer;
  d2: Buffer;
  d2Key: Buffer;
}

/**
 * native 的 `openSession` 入参是**扁平**的：`wrapperPath` / `signCoreRva` / `vmRva`
 * 直接挂在选项上，而 wire 的 `OpenSessionOptions` 把它们收在 `signer` 里。
 * 适配层负责翻译，native 不需要知道 `SignerPaths` 这个结构。
 */
interface RawOpenSessionOptions {
  session: RawSsoSessionConfig;
  mode: number;
  wrapperPath?: string | null;
  signCoreRva?: number | null;
  vmRva?: number | null;
  device?: DeviceProfile;
  wireProfile?: string;
}

interface RawQuickLoginOptions extends Omit<QuickLoginOptions, 'a1'> {
  a1: Buffer;
}

/**
 * 宿主给的原始绑定。
 *
 * 形状对齐 `nt_helper` 的 napi 导出：字节参数是 `Buffer`，返回也是 `Buffer`。
 */
export interface RawNativeBinding {
  sendPacket?(
    sessionId: number,
    cmd: string,
    body: Buffer,
    needSign?: boolean | null,
    signMode?: number | null,
  ): Promise<Buffer>;

  sendOidbPacket?(
    sessionId: number,
    command: number,
    subCommand: number,
    body: Buffer,
    isUid: boolean,
    needSign: boolean,
    signMode?: number | null,
  ): Promise<Buffer>;

  quickLogin?(
    options: RawQuickLoginOptions,
    onEvent?: (error: Error | null, event: unknown) => unknown,
  ): Promise<QuickLoginResult>;

  openSession?(options: RawOpenSessionOptions): Promise<OpenedSession>;
  closeSession?(sessionId: number, reason?: string): Promise<boolean>;
  getSession?(sessionId: number): Promise<SessionInfo | null>;
  setSecToken?(sessionId: number, token: string): Promise<boolean>;
  attachPushSink?(
    sessionId: number,
    sink: (error: Error | null, frame: PushFrame) => void,
  ): Promise<void>;
  detachPushSink?(sessionId: number): Promise<boolean>;
  attachStatusSink?(sessionId: number, sink: (event: SessionStatusEvent) => void): Promise<void>;
  detachStatusSink?(sessionId: number): Promise<boolean>;

  /** napi 导出名是 `resolveQqWrapperPath`，且是**同步**函数；适配层包成 Promise。 */
  resolveQqWrapperPath?(): string | null;
  /** 同步判断 QQ 本体是否在线（按 `nt_msg.db` 的文件锁持有进程）。 */
  isQqLoggedIn?(dbPath: string): boolean;
  warmupSigner?(wrapperPath: string): Promise<{ signCoreRva: number; vmRva: number }>;
  getBuildInfo?(): NativeBuildInfo;
}

export function adaptNativeBinding(raw: RawNativeBinding): NativePort {
  const adapted: Partial<NativePort> = {};

  if (raw.sendPacket) {
    const call = raw.sendPacket.bind(raw);
    adapted.sendPacket = async (sessionId, cmd, body, needSign, signMode) =>
      new Uint8Array(await call(sessionId, cmd, Buffer.from(body), needSign, signMode));
  }

  if (raw.sendOidbPacket) {
    const call = raw.sendOidbPacket.bind(raw);
    adapted.sendOidbPacket = async (
      sessionId,
      command,
      subCommand,
      body,
      isUid,
      needSign,
      signMode,
    ) =>
      new Uint8Array(
        await call(sessionId, command, subCommand, Buffer.from(body), isUid, needSign, signMode),
      );
  }

  if (raw.quickLogin) {
    const call = raw.quickLogin.bind(raw);
    adapted.quickLogin = (options, onEvent) =>
      call({ ...options, a1: Buffer.from(options.a1) }, onEvent);
  }

  if (raw.openSession) {
    const call = raw.openSession.bind(raw);
    adapted.openSession = (options) =>
      call({
        session: {
          ...options.session,
          a2: Buffer.from(options.session.a2),
          d2: Buffer.from(options.session.d2),
          d2Key: Buffer.from(options.session.d2Key),
        },
        mode: options.mode,
        wrapperPath: options.signer.wrapperPath,
        signCoreRva: options.signer.signCoreRva,
        vmRva: options.signer.vmRva,
        device: options.device,
        wireProfile: options.wireProfile,
      });
  }

  if (raw.closeSession) {
    const call = raw.closeSession.bind(raw);
    adapted.closeSession = async (sessionId, reason) => {
      await call(sessionId, reason);
    };
  }

  if (raw.getSession) {
    const call = raw.getSession.bind(raw);
    adapted.getSession = (sessionId: SessionId) => call(sessionId);
  }

  if (raw.setSecToken) {
    const call = raw.setSecToken.bind(raw);
    adapted.setSecToken = (sessionId, token) => call(sessionId, token);
  }

  if (raw.attachPushSink) {
    const call = raw.attachPushSink.bind(raw);
    const detach = raw.detachPushSink?.bind(raw);
    adapted.attachPushSink = async (sessionId, sink, onError) => {
      await call(sessionId, (error, frame) => {
        if (error) {
          onError?.(error);
          return;
        }
        sink(frame);
      });
      return () => {
        void detach?.(sessionId);
      };
    };
  }

  if (raw.attachStatusSink) {
    const call = raw.attachStatusSink.bind(raw);
    const detach = raw.detachStatusSink?.bind(raw);
    adapted.attachStatusSink = async (sessionId, sink) => {
      await call(sessionId, sink);
      return () => {
        void detach?.(sessionId);
      };
    };
  }

  if (raw.resolveQqWrapperPath) {
    const call = raw.resolveQqWrapperPath.bind(raw);
    // native 是同步函数；wire 统一 Promise，调用方无需区分。
    adapted.resolveWrapperPath = async () => call();
  }

  if (raw.isQqLoggedIn) {
    const call = raw.isQqLoggedIn.bind(raw);
    adapted.isQqLoggedIn = async (dbPath) => call(dbPath);
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
