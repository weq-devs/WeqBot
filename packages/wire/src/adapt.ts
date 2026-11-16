/**
 * 把宿主的原生绑定适配成 {@link NativePort}。
 *
 * 两个真实来源：
 *   - WeQ desktop：`platform.native.ntHelper`（`@weq/native` 的 `NtHelperBinding`）；
 *   - 独立进程：`@weqbot/node` 的加载器（同一份 `nt_helper.node`，形状与 WeQ 一致）。
 *
 * 适配层只做两件事：**字节类型归一**（`Uint8Array` → `Buffer`）和**保留 this**。
 * 它不做版本判断，能力探测交给 `capabilities.ts`；缺失的方法保持 `undefined`，
 * 不补桩，这样探测看到的是真实情况。
 */

import { createLogger } from '@weqbot/common';
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
  /**
   * 注意 sink 的形状：native 侧是 `ThreadsafeFunction<T>`，**按 Node 约定以
   * `(err, value)` 调用**。声明成单参数会写出一段编译通过、真机必崩的代码。
   */
  attachStatusSink?(
    sessionId: number,
    sink: (error: Error | null, event: SessionStatusEvent) => void,
  ): Promise<void>;
  detachStatusSink?(sessionId: number): Promise<boolean>;

  /** napi 导出名是 `resolveQqWrapperPath`，且是**同步**函数；适配层包成 Promise。 */
  resolveQqWrapperPath?(): string | null;
  /** 同步判断 QQ 本体是否在线（按 `nt_msg.db` 的文件锁持有进程）。 */
  isQqLoggedIn?(dbPath: string): boolean;
  /**
   * 从 QQ 进程内存读一次会话物料（进程层诊断能力）。
   *
   * 不进 `NativePort`：mode 2 自己登录，不需要借别人的会话；只有 `--print-capabilities`
   * 这类诊断会直接调它，看 `secTokenSource` / TTL。
   */
  scanSessionMaterial?(
    pid: number,
    uin?: string | null,
    uid?: string | null,
  ): Promise<{
    a2?: string;
    d2?: string;
    d2Key?: string;
    secToken?: string;
    secTokenExpire?: number;
    secTokenSource?: string;
  }>;
  warmupSigner?(wrapperPath: string): Promise<{ signCoreRva: number; vmRva: number }>;
  /** native 初始化状态：0 成功、-1 过期、-200 损坏、-201 被篡改。 */
  getInitStatus?(): number;
  getBuildInfo?(): NativeBuildInfo;

  /** FTF → TTF 字体转换（进程层能力）。 */
  convertFontAsync?(
    inputPath: string,
    outputPath: string,
    options?: import('./types').ConvertFontOptions,
  ): Promise<string>;
  convertFont?(
    inputPath: string,
    outputPath: string,
    options?: import('./types').ConvertFontOptions,
  ): string;
  getFontPipelineVersion?(): number;

  // ── 登录页（WebUI W4）用的进程层能力 ────────────────────────────────
  //
  // 这些**不进 `NativePort`**：它们是「读本机 QQ 的离线资料」，与 bot 上线链路
  // 无关，只有 `@weqbot/node` 的 WebUI 服务直接调。

  /** `login.db` 的固定 pre-login key 探测：给出页 HMAC / KDF HMAC 算法。 */
  testDatabaseKey?(
    dbPath: string,
    key: string,
  ): Promise<{
    success: boolean;
    pageHmacAlgorithm?: string | null;
    kdfHmacAlgorithm?: string | null;
  }>;
  /** 用探测出的算法解密 `login.db`，返回账号行；**同步**函数（native 侧不是 async）。 */
  decryptLoginDb?(
    loginDbPath: string,
    algo: { pageHmacAlgorithm: string; kdfHmacAlgorithm: string },
  ): Array<{
    uin: string;
    uid: string;
    avatarUrl?: string;
    userName?: string;
    a1Key?: string;
    lastLoginAt?: number;
    a1Payload?: string | null;
    guid?: string | null;
  }>;
  /** `major.node` → `{ appid, qua, version, build }`。 */
  resolveAppidFromMajor?(majorPath: string): {
    appid: string;
    qua?: string | null;
    version?: string | null;
    build?: string | null;
  };
  /** 从数据根离线计算设备 guid（32 位小写 hex）。 */
  readDeviceGuid?(dataRoot: string): string | null;
  /** 二维码登录。事件与 `quickLogin` 的 `onEvent` 同一形状。 */
  qrLogin?(
    options: RawQuickLoginOptions,
    onEvent?: (error: Error | null, event: unknown) => unknown,
  ): Promise<QuickLoginResult>;
}

export function adaptNativeBinding(raw: RawNativeBinding): NativePort {
  const adapted: Partial<NativePort> = {};
  const log = createLogger('wire');

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
      // **必须包一层。** native 的 `ThreadsafeFunction<T>` 按 Node 约定调用
      // `(err, value)`，直接把 `sink` 传下去会让回调收到 `(null, event)` ——
      // 第一个参数恒为 null，`event.kind` 立刻抛 TypeError，而且是在 native
      // 的 TSFN 里抛的，会把整个进程带下去。`attachPushSink` 一直是包着的，
      // 这里当初漏了（P2 起就存在，真机一挂 status sink 就崩）。
      await call(sessionId, (error: Error | null, event: SessionStatusEvent) => {
        if (error) {
          log.warn('状态通道报错', { sessionId, cause: error });
          return;
        }
        if (event) sink(event);
      });
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

  if (raw.convertFontAsync) {
    const call = raw.convertFontAsync.bind(raw);
    adapted.convertFontAsync = (inputPath, outputPath, options) =>
      call(inputPath, outputPath, options);
  }

  if (raw.convertFont) {
    const call = raw.convertFont.bind(raw);
    adapted.convertFont = (inputPath, outputPath, options) => call(inputPath, outputPath, options);
  }

  if (raw.getFontPipelineVersion) {
    const call = raw.getFontPipelineVersion.bind(raw);
    adapted.getFontPipelineVersion = () => call();
  }

  return adapted as NativePort;
}
