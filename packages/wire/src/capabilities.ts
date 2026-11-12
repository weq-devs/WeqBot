/**
 * 能力探测。
 *
 * 宿主可能给一份「旧产物」或「阉割产物」：缺 `openOnline` 的 native 在老 WeQ 里
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
  /** 借 QQ 会话物料（WeQ 现在的路径）。 */
  | 'mode1'
  /** `quickLogin(a1)`。 */
  | 'quickLogin'
  /** `openOnline` / `closeOnline`（mode2 的全部前提）。 */
  | 'openOnline'
  | 'pushSink'
  | 'statusSink'
  | 'signer'
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
  ['mode1', (nt) => typeof nt.setSsoSession === 'function'],
  ['quickLogin', (nt) => typeof nt.quickLogin === 'function'],
  [
    'openOnline',
    (nt) => typeof nt.openOnline === 'function' && typeof nt.closeOnline === 'function',
  ],
  ['pushSink', (nt) => typeof nt.attachPushSink === 'function'],
  ['statusSink', (nt) => typeof nt.attachStatusSink === 'function'],
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
