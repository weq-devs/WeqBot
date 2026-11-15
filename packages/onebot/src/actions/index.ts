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

import type { ActionDoc, ActionEntry } from '../action-registry';
import {
  describeAction,
  isDeniedAction,
  type ActionDefinition,
  type ActionRegistry,
} from '../action-registry';
import type { OneBotBackend } from '../backend';
import { ACCOUNT_ACTIONS } from './account';
import { ACCOUNT_WEB_ACTIONS } from './account-web';
import { COLLECTION_ACTIONS } from './collection';
import { CONTACT_ACTIONS } from './contact';
import { GROUP_ADMIN_ACTIONS } from './group-admin';
import { GROUP_WEB_ACTIONS } from './group-web';
import { GROUP_FILE_ACTIONS } from './group-file';
import { INTERACTION_ACTIONS } from './interaction';
import { MESSAGE_ACTIONS } from './message';
import { EXTENDED_ACTIONS } from './extended';
import { FLASH_TRANSFER_ACTIONS } from './flash-transfer';
import { L2_EXTRA_ACTIONS } from './l2-extra';
import { QZONE_ACTIONS } from './qzone';

export type { ActionEntry } from '../action-registry';

/**
 * 全部 action 的文档元数据（含当前后端未实现、会被跳过的 action）。
 *
 * 文档生成器 / 测试页应当读这个而不是注册表，否则部署差异会让文档随能力漂移。
 */
export function describeActions(entries: readonly ActionEntry[] = ALL_ACTIONS): ActionDoc[] {
  return entries.map((entry) => describeAction(entry.definition));
}

/**
 * 每组 action 的来源文件 → 能力域。**装配时统一打标**，不在 200 多条声明里各写一遍。
 *
 * `write` 是**整组默认值**：域内既有读也有写时留 `false`，由单条声明自己标 ——
 * 调试页拿它做二次确认，宁可漏标也不要把只读操作误标成写。
 */
const ACTION_GROUPS: ReadonlyArray<readonly [ActionEntry[], string, boolean]> = [
  [MESSAGE_ACTIONS, 'message', false],
  [CONTACT_ACTIONS, 'contact', false],
  [GROUP_ADMIN_ACTIONS, 'group-admin', false],
  [INTERACTION_ACTIONS, 'interaction', false],
  [GROUP_FILE_ACTIONS, 'group-file', false],
  [EXTENDED_ACTIONS, 'extended', false],
  [FLASH_TRANSFER_ACTIONS, 'flash-transfer', false],
  [L2_EXTRA_ACTIONS, 'l2-extra', false],
  [ACCOUNT_ACTIONS, 'account', false],
  [GROUP_WEB_ACTIONS, 'group-web', false],
  [ACCOUNT_WEB_ACTIONS, 'account-web', false],
  [COLLECTION_ACTIONS, 'collection', false],
  [QZONE_ACTIONS, 'qzone', false],
];

/** 已知会改变 QQ 侧状态的 action 名（精确匹配）。 */
const KNOWN_WRITE_ACTIONS = new Set<string>([
  'set_group_kick_members',
  'set_group_admin',
  'set_group_card',
  'set_group_name',
  'set_group_whole_ban',
  'set_group_ban',
  'set_group_leave',
  'set_group_special_title',
  'set_group_remark',
  'set_group_add_request',
  'set_friend_add_request',
  'set_friend_remark',
  'delete_friend',
  'set_group_add_option',
  'add_group_tag',
  'delete_group_tag',
  'set_group_admin_permissions',
  'set_group_admin_receive_verify',
  'set_group_robot_add_option',
  'set_group_portrait',
  'set_group_search',
  'set_group_member_invite_policy',
  'set_group_new_member_history_visibility',
  'set_group_member_permissions',
  'set_group_anonymous',
  'set_group_anonymous_ban',
  'set_essence_msg',
  'delete_essence_msg',
  'set_qq_profile',
  'set_qq_avatar',
  'set_self_longnick',
  'set_input_status',
  'set_friends_category',
  'set_online_status',
  'set_diy_online_status',
  'send_gift',
  'forward_qzone_msg',
  'set_qzone_msg_right',
  'set_qzone_ban',
  'set_qzone_profile',
  'send_qzone_msg',
  'delete_qzone_msg',
  'like_qzone',
  'unlike_qzone',
  'comment_qzone',
  'set_qzone_public_upvote',
  'set_qzone_public_like',
  'set_qzone_public_comment_like',
  'comment_qzone_public_feed',
  'reply_qzone_public_feed',
  'delete_qzone_public_comment',
  'delete_qzone_public_reply',
  'set_qzone_public_follow',
  'forward_qzone_public_feed',
]);

/** 名字以这些前缀开头的算写操作（`send_*` / `delete_*` / `upload_*` / `set_*` …）。 */
const WRITE_PREFIXES = ['send_', 'delete_', 'upload_', 'set_', 'add_', 'create_', 'del_'];

function isWriteAction(name: string): boolean {
  if (KNOWN_WRITE_ACTIONS.has(name)) return true;
  // `get_*` / 查询类一律不算写，即使前缀表命中（如 `set_` 没有这种）——先排除只读。
  return WRITE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export const ALL_ACTIONS: ActionEntry[] = ACTION_GROUPS.flatMap(([entries, group, groupWrite]) =>
  entries.map((entry) => ({
    ...entry,
    definition: {
      ...entry.definition,
      group: entry.definition.group ?? group,
      write: entry.definition.write ?? (groupWrite || isWriteAction(entry.definition.name)),
    },
  })),
);

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

export { ACCOUNT_ACTIONS } from './account';
export { ACCOUNT_WEB_ACTIONS } from './account-web';
export { COLLECTION_ACTIONS } from './collection';
export { CONTACT_ACTIONS } from './contact';
export { GROUP_ADMIN_ACTIONS } from './group-admin';
export { GROUP_FILE_ACTIONS } from './group-file';
export { GROUP_WEB_ACTIONS } from './group-web';
export { INTERACTION_ACTIONS } from './interaction';
export { MESSAGE_ACTIONS } from './message';
export { EXTENDED_ACTIONS } from './extended';
export { FLASH_TRANSFER_ACTIONS } from './flash-transfer';
export { L2_EXTRA_ACTIONS } from './l2-extra';
export { QZONE_ACTIONS } from './qzone';

// 供仍在使用旧形状的调用方（`ActionDefinition` 泛型）引用。
export type { ActionDefinition };
