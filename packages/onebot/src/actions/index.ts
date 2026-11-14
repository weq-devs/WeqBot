/**
 * action 集合的汇总与装配。
 *
 * 新增一类 action 时：写 `actions/<area>.ts`，导出一个 `ActionEntry[]`，
 * 在这里拼进 `ALL_ACTIONS`。注册表会跳过后端没实现的能力 —— 「协议没覆盖」
 * 与「注册了但一调就崩」被结构性地挡住了。
 *
 * 能力判定有两种写法：
 *   - `requires: ['getFriendList']` —— 旧的扁平方法名；
 *   - `available: (backend) => !!backend.qzone` —— P8 起的按域分组能力。
 * 两者都给时以 `available` 为准。
 */

import type { ActionEntry } from '../action-registry';
import { isDeniedAction, type ActionDefinition, type ActionRegistry } from '../action-registry';
import type { OneBotBackend } from '../backend';
import { ACCOUNT_WEB_ACTIONS } from './account-web';
import { CONTACT_ACTIONS } from './contact';
import { GROUP_ADMIN_ACTIONS } from './group-admin';
import { GROUP_WEB_ACTIONS } from './group-web';
import { GROUP_FILE_ACTIONS } from './group-file';
import { INTERACTION_ACTIONS } from './interaction';
import { MESSAGE_ACTIONS } from './message';
import { EXTENDED_ACTIONS } from './extended';
import { QZONE_ACTIONS } from './qzone';

export type { ActionEntry } from '../action-registry';

export const ALL_ACTIONS: ActionEntry[] = [
  ...MESSAGE_ACTIONS,
  ...CONTACT_ACTIONS,
  ...GROUP_ADMIN_ACTIONS,
  ...INTERACTION_ACTIONS,
  ...GROUP_FILE_ACTIONS,
  ...EXTENDED_ACTIONS,
  ...GROUP_WEB_ACTIONS,
  ...ACCOUNT_WEB_ACTIONS,
  ...QZONE_ACTIONS,
];

/** 后端能否满足这条 action 的能力要求。 */
function backendSupports(backend: OneBotBackend, entry: ActionEntry): boolean {
  if (entry.available) return entry.available(backend);
  if (!entry.requires) return true;
  return entry.requires.every((name) => typeof backend[name] === 'function');
}

/**
 * 把 action 注册进注册表。
 *
 * 返回被跳过的 action 名，便于启动日志说明「为什么某个 action 没出现」。
 */
export function registerActions(
  registry: ActionRegistry,
  backend: OneBotBackend,
): { registered: string[]; skipped: string[] } {
  const registered: string[] = [];
  const skipped: string[] = [];

  for (const entry of ALL_ACTIONS) {
    const { definition } = entry;
    // 敏感能力永远不注册，即使后端实现了。
    if (isDeniedAction(definition.name)) {
      skipped.push(definition.name);
      continue;
    }
    if (!backendSupports(backend, entry)) {
      skipped.push(definition.name);
      continue;
    }
    registry.register(definition);
    registered.push(definition.name);
  }

  return { registered, skipped };
}

export { ACCOUNT_WEB_ACTIONS } from './account-web';
export { CONTACT_ACTIONS } from './contact';
export { GROUP_ADMIN_ACTIONS } from './group-admin';
export { GROUP_FILE_ACTIONS } from './group-file';
export { GROUP_WEB_ACTIONS } from './group-web';
export { INTERACTION_ACTIONS } from './interaction';
export { MESSAGE_ACTIONS } from './message';
export { EXTENDED_ACTIONS } from './extended';
export { QZONE_ACTIONS } from './qzone';

// 供仍在使用旧形状的调用方（`ActionDefinition` 泛型）引用。
export type { ActionDefinition };
