/**
 * 文档快照的契约测试 —— 这是「文档不会和代码漂移」的机器保证。
 *
 * 三道门禁：
 *
 *   1. **快照不漂**：`schema/onebot-actions.json` 必须等于当前代码算出来的结果。
 *      改了 action 的 summary / description / inputSchema 却没重跑 `pnpm docs:actions`
 *      → 这里红灯。这是把「记得同步文档」从人的责任变成 CI 的责任。
 *   2. **分组不漏**：`actions/*.ts` 里每个导出的 `*_ACTIONS` 都必须在快照的分组表里
 *      出现，且总条数等于 `ALL_ACTIONS`。新增一个 action 模块时忘记加分组 → 红灯。
 *   3. **形状合法**：文档站按这个形状渲染，字段缺失或类型不对会让站点构建失败。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ALL_ACTIONS, describeActions } from '../src/actions';
import { buildActionsSnapshot } from '../src/docs/snapshot';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const SNAPSHOT_PATH = join(root, 'schema', 'onebot-actions.json');

function readCommitted(): unknown {
  return JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));
}

test('schema/onebot-actions.json 与代码一致', () => {
  const expected = buildActionsSnapshot();
  const actual = readCommitted();
  assert.deepEqual(
    actual,
    JSON.parse(JSON.stringify(expected)),
    '快照与代码不一致：改了 action 后请重跑 `pnpm docs:actions`',
  );
});

test('快照覆盖全部 action，且没有重复', () => {
  const snapshot = buildActionsSnapshot();
  const names = snapshot.groups.flatMap((group) => group.actions.map((action) => action.name));

  assert.equal(
    names.length,
    ALL_ACTIONS.length,
    `快照里有 ${names.length} 条，ALL_ACTIONS 有 ${ALL_ACTIONS.length} 条 —— ` +
      '是不是新增了 actions/*.ts 模块但没加进 docs/snapshot.ts 的 GROUPS？',
  );
  assert.deepEqual([...new Set(names)].sort(), names.slice().sort(), '快照里有重复的 action 名');
  assert.deepEqual(
    names.slice().sort(),
    describeActions()
      .map((doc) => doc.name)
      .sort(),
    '快照与 describeActions() 的集合不一致',
  );
});

test('分组统计与明细自洽', () => {
  const snapshot = buildActionsSnapshot();
  const { totals } = snapshot;
  const fromGroups = snapshot.groups.reduce((sum, group) => sum + group.actions.length, 0);

  assert.equal(totals.groups, snapshot.groups.length);
  assert.equal(totals.actions, fromGroups);
  assert.equal(
    totals.withParams,
    snapshot.groups.reduce(
      (sum, group) => sum + group.actions.filter((action) => action.params.length > 0).length,
      0,
    ),
  );
});

test('每个分组都有唯一的 key，且都带展示名', () => {
  const snapshot = buildActionsSnapshot();
  const keys = snapshot.groups.map((group) => group.key);
  assert.deepEqual([...new Set(keys)].sort(), keys.slice().sort(), '分组 key 重复');

  for (const group of snapshot.groups) {
    assert.ok(group.key.length > 0, '分组缺 key');
    assert.ok(group.label.length > 0, `分组 ${group.key} 缺展示名`);
    assert.ok(group.actions.length > 0, `分组 ${group.key} 是空的`);
  }
});

test('每条快照条目的字段形状都可直接渲染', () => {
  const snapshot = buildActionsSnapshot();
  for (const group of snapshot.groups) {
    for (const action of group.actions) {
      const where = `${group.key}/${action.name}`;
      assert.equal(typeof action.name, 'string');
      assert.ok(action.name.length > 0, `${where} 缺 name`);
      assert.equal(typeof action.summary, 'string', `${where} 的 summary 类型不对`);
      assert.ok(action.description.length > 0, `${where} 的 description 不能为空`);
      assert.equal(action.inputSchema.type, 'object', `${where} 的 inputSchema 必须是 object`);

      // `params` / `required` 是给表格列用的派生物，必须与 schema 自洽。
      const properties = action.inputSchema.properties as Record<string, unknown> | undefined;
      assert.deepEqual(
        action.params,
        properties ? Object.keys(properties) : [],
        `${where} 的 params 与 inputSchema.properties 不一致`,
      );
      for (const field of action.required) {
        assert.ok(
          action.params.includes(field),
          `${where} 的 required 字段 ${field} 不在 params 里`,
        );
      }

      assert.ok(
        ['always', 'requires', 'predicate'].includes(action.capability.mode),
        `${where} 的 capability.mode 非法`,
      );
      if (action.capability.mode === 'requires') {
        assert.ok(action.capability.requires.length > 0, `${where} 的 requires 是空的`);
      }
    }
  }
});

test('敏感能力不出现在分组里，只出现在 deny-list', () => {
  const snapshot = buildActionsSnapshot();
  assert.ok(snapshot.deniedActions.length > 0, 'deny-list 不应为空');

  const names = new Set(snapshot.groups.flatMap((group) => group.actions.map((a) => a.name)));
  for (const denied of snapshot.deniedActions) {
    assert.ok(!names.has(denied), `敏感能力 ${denied} 不应出现在 action 分组里`);
  }
});
