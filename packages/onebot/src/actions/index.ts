/**
 * action 集合的汇总与装配。
 *
 * 新增一类 action 时：写 `actions/<area>.ts`，导出一个数组（每项带 `requires`），
 * 在这里拼进 `ALL_ACTIONS`。`registerActions` 会跳过后端没实现的能力 —— 这样
 * 「协议没覆盖」与「注册了但一调就崩」被结构性地挡住了。
 */

import type { OneBotBackend } from '../backend';
import { isDeniedAction, type ActionDefinition, type ActionRegistry } from '../action-registry';
import { CONTACT_ACTIONS } from './contact';
import { GROUP_ADMIN_ACTIONS } from './group-admin';
import { INTERACTION_ACTIONS } from './interaction';
import { MESSAGE_ACTIONS } from './message';

export interface ActionEntry {
  definition: ActionDefinition<never, never>;
  requires: Array<keyof OneBotBackend>;
}

export const ALL_ACTIONS: ActionEntry[] = [
  ...MESSAGE_ACTIONS,
  ...CONTACT_ACTIONS,
  ...GROUP_ADMIN_ACTIONS,
  ...INTERACTION_ACTIONS,
];

/** 后端能否满足这组要求。 */
function backendSupports(backend: OneBotBackend, requires: Array<keyof OneBotBackend>): boolean {
  return requires.every((name) => typeof backend[name] === 'function');
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

  for (const { definition, requires } of ALL_ACTIONS) {
    // 敏感能力永远不注册，即使后端实现了。
    if (isDeniedAction(definition.name)) {
      skipped.push(definition.name);
      continue;
    }
    if (!backendSupports(backend, requires)) {
      skipped.push(definition.name);
      continue;
    }
    registry.register(definition);
    registered.push(definition.name);
  }

  return { registered, skipped };
}

export { CONTACT_ACTIONS } from './contact';
export { GROUP_ADMIN_ACTIONS } from './group-admin';
export { INTERACTION_ACTIONS } from './interaction';
export { MESSAGE_ACTIONS } from './message';
