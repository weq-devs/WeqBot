/**
 * OneBot action 的**文档快照**：把 `ALL_ACTIONS` + `action-metadata.ts` 投影成
 * 一份可以直接给文档站消费的 JSON。
 *
 * 为什么要有这一层：
 *
 *   - 文档站（`weq-devs/WeqBotDocs`）是独立仓库，读不到 `@weqbot/onebot` 的源码；
 *     它只消费 `schema/onebot-actions.json` 这份快照。
 *   - 快照**提交在主仓**，不是提交在文档仓。这样「改了 action」和「更新了文档数据」
 *     是同一个 PR 里的两行改动，漂移在 CI 里直接红灯，不用等谁记得去同步 submodule。
 *
 * 这个文件是**纯函数**：不碰 `fs`、不读环境变量。落盘在
 * `scripts/dump-onebot-docs.mjs`，一致性校验在 `test/actions-snapshot.test.ts`。
 *
 * ## 快照里有什么、没有什么
 *
 * 有：分组、名字、摘要、长描述、入参 JSON Schema、能力判定方式、敏感能力标记。
 *
 * 没有：
 *   - **返回结构**。`run()` 的返回值是 TS 类型，运行时已擦除，静态推不出来。
 *     要补只能在 `action-metadata.ts` 里手写 `outputSchema`，那是另一轮工作。
 *   - **能力谓词的结果**。`available` 是函数，取决于运行时注入的后端；
 *     这里只记录「它怎么判定的」，不记录「当前是否可用」。
 */

import { DENIED_ACTIONS, type ActionDoc, describeAction, isDeniedAction } from '../action-registry';
import type { ActionEntry } from '../actions';
import {
  ACCOUNT_ACTIONS,
  ACCOUNT_WEB_ACTIONS,
  COLLECTION_ACTIONS,
  CONTACT_ACTIONS,
  EXTENDED_ACTIONS,
  FLASH_TRANSFER_ACTIONS,
  GROUP_ADMIN_ACTIONS,
  GROUP_FILE_ACTIONS,
  GROUP_WEB_ACTIONS,
  INTERACTION_ACTIONS,
  L2_EXTRA_ACTIONS,
  MESSAGE_ACTIONS,
  QZONE_ACTIONS,
} from '../actions';
import type { OneBotBackend } from '../backend';
import type { JsonSchema } from '../action-metadata';

/** 快照版本；形状破坏性变更时 +1，文档站那边要跟着改渲染。 */
export const ACTIONS_SNAPSHOT_VERSION = 1;

/**
 * 能力判定方式。
 *
 * - `always`：不依赖后端任何能力，一定注册；
 * - `requires`：后端得实现这里列出的扁平方法；
 * - `predicate`：按域分组的能力谓词（P8 起），静态看不出来具体依赖什么。
 */
export type CapabilityGate =
  | { mode: 'always' }
  | { mode: 'requires'; requires: string[] }
  | { mode: 'predicate' };

export interface ActionSnapshotEntry {
  name: string;
  summary: string;
  description: string;
  inputSchema: JsonSchema;
  /** `inputSchema.properties` 的键，按声明顺序。给表格列用，省得文档站自己递归。 */
  params: string[];
  /** `inputSchema.required`；空数组表示没有必填项。 */
  required: string[];
  /** 是否属于敏感能力（红包 / 转账 / 支付）。这类**永不注册**，只在文档里列出以示边界。 */
  denied: boolean;
  capability: CapabilityGate;
  /** 是否写操作（改变 QQ 侧状态）。调试页据此做二次确认。 */
  write: boolean;
}

export interface ActionGroupSnapshot {
  /** 源模块名，如 `group-admin`。 */
  key: string;
  /** 展示名。 */
  label: string;
  actions: ActionSnapshotEntry[];
}

export interface ActionsSnapshot {
  version: typeof ACTIONS_SNAPSHOT_VERSION;
  generatedFrom: string;
  totals: {
    actions: number;
    groups: number;
    /** 有入参的 action 数（`params` 非空）。 */
    withParams: number;
  };
  /**
   * 敏感能力 deny-list 原文。
   *
   * 这些**不在** `groups` 里 —— 它们在 `registerActions` 阶段就被 `isDeniedAction`
   * 拦掉了，所以 `ActionSnapshotEntry.denied` 恒为 false。条目自身保留 `denied`
   * 字段是为了将来放宽某条时不必改形状，但真正要展示给读者的边界说明是这份名单。
   */
  deniedActions: string[];
  groups: ActionGroupSnapshot[];
}

/**
 * 分组 = 源模块。
 *
 * 这是**唯一**从代码里天然可得的分类信息：`ActionDoc` 本身不带分组，而
 * `actions/*.ts` 的文件边界就是维护者认可的归类。新增一个 action 模块时，
 * 这里必须同步加一行 —— `test/actions-snapshot.test.ts` 会检查有没有漏。
 */
const GROUPS: ReadonlyArray<{ key: string; label: string; entries: readonly ActionEntry[] }> = [
  { key: 'message', label: '消息', entries: MESSAGE_ACTIONS },
  { key: 'contact', label: '联系人', entries: CONTACT_ACTIONS },
  { key: 'group-admin', label: '群管理', entries: GROUP_ADMIN_ACTIONS },
  { key: 'interaction', label: '互动', entries: INTERACTION_ACTIONS },
  { key: 'group-file', label: '群文件', entries: GROUP_FILE_ACTIONS },
  { key: 'extended', label: '扩展', entries: EXTENDED_ACTIONS },
  { key: 'flash-transfer', label: '闪传', entries: FLASH_TRANSFER_ACTIONS },
  { key: 'l2-extra', label: '二级扩展', entries: L2_EXTRA_ACTIONS },
  { key: 'account', label: '账号', entries: ACCOUNT_ACTIONS },
  { key: 'group-web', label: '群 Web', entries: GROUP_WEB_ACTIONS },
  { key: 'account-web', label: '账号 Web', entries: ACCOUNT_WEB_ACTIONS },
  { key: 'collection', label: '收藏', entries: COLLECTION_ACTIONS },
  { key: 'qzone', label: 'QQ 空间', entries: QZONE_ACTIONS },
];

function gateOf(entry: ActionEntry): CapabilityGate {
  if (entry.available) return { mode: 'predicate' };
  if (entry.requires && entry.requires.length > 0) {
    return {
      mode: 'requires',
      requires: entry.requires.map((name) => String(name as keyof OneBotBackend)),
    };
  }
  return { mode: 'always' };
}

/** `inputSchema.properties` / `required` 的宽松读取（schema 是 `Record<string, unknown>`）。 */
function schemaFields(schema: JsonSchema): { params: string[]; required: string[] } {
  const properties = schema.properties;
  const params =
    typeof properties === 'object' && properties !== null && !Array.isArray(properties)
      ? Object.keys(properties as Record<string, unknown>)
      : [];
  const requiredValue = schema.required;
  const required =
    Array.isArray(requiredValue) && requiredValue.every((item) => typeof item === 'string')
      ? (requiredValue as string[])
      : [];
  return { params, required };
}

function entryOf(doc: ActionDoc, entry: ActionEntry): ActionSnapshotEntry {
  const { params, required } = schemaFields(doc.inputSchema);
  return {
    name: doc.name,
    summary: doc.summary ?? '',
    description: doc.description,
    inputSchema: doc.inputSchema,
    params,
    required,
    denied: isDeniedAction(doc.name),
    capability: gateOf(entry),
    // 写标记参与「这是不是危险调用」的判断，文档站与 WebUI 调试页共用同一口径。
    write: entry.definition.write ?? false,
  };
}

/**
 * 构造快照。
 *
 * 不传参数时用全部 action；测试可以传一组自定义 entry 验证投影逻辑。
 */
export function buildActionsSnapshot(
  groups: ReadonlyArray<{ key: string; label: string; entries: readonly ActionEntry[] }> = GROUPS,
): ActionsSnapshot {
  const out: ActionGroupSnapshot[] = groups.map((group) => ({
    key: group.key,
    label: group.label,
    actions: group.entries.map((entry) => entryOf(describeAction(entry.definition), entry)),
  }));

  const actions = out.reduce((sum, group) => sum + group.actions.length, 0);
  const withParams = out.reduce(
    (sum, group) => sum + group.actions.filter((action) => action.params.length > 0).length,
    0,
  );

  return {
    version: ACTIONS_SNAPSHOT_VERSION,
    generatedFrom: 'packages/onebot/src/actions',
    totals: { actions, groups: out.length, withParams },
    deniedActions: [...DENIED_ACTIONS],
    groups: out,
  };
}
