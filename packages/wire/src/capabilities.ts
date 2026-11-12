/**
 * 能力探测。
 *
 * 宿主可能给一份「旧产物」或「阉割产物」：缺 `openSession` 的 native 在旧安装里
 * 到处都是。bot 不能在启动时崩，也不能假装自己在线 —— 必须**先探测、再明确拒绝**。
 *
 * 判据是 `typeof nt.x === 'function'`，不是版本号：版本号在 WeQ 里跟 QQ 版本、
 * 构建批次纠缠，不可靠；接口在不在是二值事实。
 */

import { WeqBotError } from '@weqbot/common';
import type { NativePort } from './types';

export type NativeCapability =
  | 'sendPacket'
  | 'sendOidb'
  /** `quickLogin(a1)` / `qrLogin`：凭据换票。 */
  | 'quickLogin'
  /** `openSession` / `closeSession`：会话生命周期的全部前提。 */
  | 'openSession'
  /** `setSecToken`：长跑时原地轮换签名 token。 */
  | 'tokenRefresh'
  /** `attachPushSink`。 */
  | 'pushSink'
  /** `attachStatusSink`。 */
  | 'statusSink'
  /** 已安装 QQ 的 `wrapper.node` 探测（进程层）。 */
  | 'wrapperResolver'
  /** QQ 本体是否在线（`isQqLoggedIn`，进程层）。 */
  | 'qqLoginDetector'
  /** `warmupSigner`。 */
  | 'signer'
  /** `getBuildInfo`。 */
  | 'buildInfo';

export interface CapabilityReport {
  has(capability: NativeCapability): boolean;
  missing(capabilities: readonly NativeCapability[]): NativeCapability[];
  /** 缺能力就抛 `NATIVE_MISSING_CAPABILITY`，`hint` 进错误消息便于用户知道要升级什么。 */
  require(capability: NativeCapability, hint?: string): void;
  requireAll(capabilities: readonly NativeCapability[], hint?: string): void;
  list(): NativeCapability[];
}

const PRESENT: Array<[NativeCapability, (nt: Partial<NativePort>) => boolean]> = [
  ['sendPacket', (nt) => typeof nt.sendPacket === 'function'],
  ['sendOidb', (nt) => typeof nt.sendOidbPacket === 'function'],
  ['quickLogin', (nt) => typeof nt.quickLogin === 'function'],
  [
    'openSession',
    (nt) => typeof nt.openSession === 'function' && typeof nt.closeSession === 'function',
  ],
  ['tokenRefresh', (nt) => typeof nt.setSecToken === 'function'],
  ['pushSink', (nt) => typeof nt.attachPushSink === 'function'],
  ['statusSink', (nt) => typeof nt.attachStatusSink === 'function'],
  ['wrapperResolver', (nt) => typeof nt.resolveWrapperPath === 'function'],
  ['qqLoginDetector', (nt) => typeof nt.isQqLoggedIn === 'function'],
  ['signer', (nt) => typeof nt.warmupSigner === 'function'],
  ['buildInfo', (nt) => typeof nt.getBuildInfo === 'function'],
];

export function inspectNative(native: Partial<NativePort>): CapabilityReport {
  const present = new Set<NativeCapability>();
  for (const [capability, probe] of PRESENT) {
    if (probe(native)) present.add(capability);
  }

  const fail = (capabilities: readonly NativeCapability[], hint?: string): never => {
    throw new WeqBotError(
      'NATIVE_MISSING_CAPABILITY',
      `原生组件缺少能力：${capabilities.join(', ')}${hint ? `（${hint}）` : ''}`,
      { fields: { missing: [...capabilities] } },
    );
  };

  return {
    has: (capability) => present.has(capability),
    missing: (capabilities) => capabilities.filter((capability) => !present.has(capability)),
    require: (capability, hint) => {
      if (!present.has(capability)) fail([capability], hint);
    },
    requireAll: (capabilities, hint) => {
      const absent = capabilities.filter((capability) => !present.has(capability));
      if (absent.length > 0) fail(absent, hint);
    },
    list: () => [...present],
  };
}
