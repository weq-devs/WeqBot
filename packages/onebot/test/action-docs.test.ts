/**
 * action 文档元数据契约。
 *
 * 目的：保证 `action-metadata.ts` 与 `ALL_ACTIONS` 不漂移，这样未来的文档 /
 * 测试页只要读注册表的 `describe()` 就能拿到完整入参 Schema。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { ActionRegistry, type ActionContext } from '../src/action-registry';
import { ACTION_METADATA } from '../src/action-metadata';
import { ALL_ACTIONS, describeActions, registerActions } from '../src/actions';
import type { OneBotBackend } from '../src/backend';

function makeBackend(overrides: Partial<OneBotBackend> = {}): OneBotBackend {
  return {
    getLoginInfo: async () => ({ userId: 10001, nickname: 'bot' }),
    sendGroupMessage: async () => ({ sequence: 1 }),
    sendPrivateMessage: async () => ({ sequence: 2 }),
    recall: async () => {},
    ...overrides,
  };
}

function makeContext(backend: OneBotBackend): ActionContext {
  return {
    selfId: 10001,
    backend,
    messageFormat: 'array',
    startedAt: Date.now(),
    internSentMessageId: () => 42,
    resolveMessageMeta: () => null,
    resolveMessageEvent: () => null,
    internMessageEvent: () => 43,
    findLatestMessageAnchor: () => null,
  };
}

test('每个 action 都有元数据，且没有多余登记', () => {
  const names = new Set(ALL_ACTIONS.map((entry) => entry.definition.name));
  const missing = [...names].filter((name) => !ACTION_METADATA[name]);
  const extra = Object.keys(ACTION_METADATA).filter((name) => !names.has(name));

  assert.deepEqual(missing, [], `缺少元数据的 action：${missing.join(', ')}`);
  assert.deepEqual(extra, [], `元数据里多出未注册的 action：${extra.join(', ')}`);
});

test('每条 inputSchema 都是 object，required 都指向已声明的属性', () => {
  for (const [name, metadata] of Object.entries(ACTION_METADATA)) {
    const schema = metadata.inputSchema as {
      type?: unknown;
      properties?: Record<string, unknown>;
      required?: unknown;
    };
    assert.equal(schema.type, 'object', `${name} 的 inputSchema 必须是 object`);
    assert.equal(typeof schema.properties, 'object', `${name} 缺少 properties`);

    const properties = schema.properties ?? {};
    for (const [field, fieldSchema] of Object.entries(properties)) {
      assert.equal(typeof fieldSchema, 'object', `${name}.${field} 的字段 schema 必须是对象`);
      assert.ok(
        typeof (fieldSchema as { description?: unknown }).description === 'string' &&
          (fieldSchema as { description: string }).description.length > 0,
        `${name}.${field} 缺少字段描述`,
      );
    }

    if (schema.required !== undefined) {
      assert.ok(Array.isArray(schema.required), `${name} 的 required 必须是数组`);
      for (const field of schema.required as string[]) {
        assert.ok(
          Object.hasOwn(properties, field),
          `${name} 的 required 字段 ${field} 不在 properties 里`,
        );
      }
    }
  }
});

test('describeActions() 覆盖全部 action（含后端未实现的）', () => {
  const docs = describeActions();
  assert.equal(docs.length, ALL_ACTIONS.length);
  assert.deepEqual(
    docs.map((doc) => doc.name),
    ALL_ACTIONS.map((entry) => entry.definition.name),
  );
  for (const doc of docs) {
    assert.ok(doc.description.length > 0, `${doc.name} 的 description 不能为空`);
    assert.equal((doc.inputSchema as { type?: unknown }).type, 'object');
  }
});

test('注册表 describe() 返回可直接用于文档 / 测试页的元数据', () => {
  const registry = new ActionRegistry();
  const backend = makeBackend();
  registerActions(registry, backend);

  const docs = registry.describe();
  assert.ok(docs.length > 0);
  assert.deepEqual(
    docs.map((doc) => doc.name).sort(),
    registry
      .list()
      .map((entry) => entry.name)
      .sort(),
  );

  for (const doc of docs) {
    assert.ok(doc.description.length > 0, `${doc.name} 的 description 不能为空`);
    const schema = doc.inputSchema as { type?: unknown; properties?: unknown };
    assert.equal(schema.type, 'object', `${doc.name} 的 inputSchema 必须是 object`);
    assert.equal(typeof schema.properties, 'object', `${doc.name} 缺少 properties`);
  }
});

test('describe() 优先使用 action 内联的 description / inputSchema', () => {
  const registry = new ActionRegistry();
  registry.register({
    name: 'inline_doc_test',
    summary: '摘要',
    description: '内联描述',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string', description: '值' } },
      required: ['value'],
      additionalProperties: true,
    },
    run: async () => null,
  });

  const [doc] = registry.describe();
  assert.equal(doc?.description, '内联描述');
  assert.deepEqual(doc?.inputSchema, {
    type: 'object',
    properties: { value: { type: 'string', description: '值' } },
    required: ['value'],
    additionalProperties: true,
  });
});

test('没有内联元数据时 description 回退到 summary', () => {
  const registry = new ActionRegistry();
  registry.register({
    name: 'fallback_doc_test',
    summary: '发送群消息',
    run: async () => null,
  });

  const [doc] = registry.describe();
  assert.ok(doc);
  assert.equal(doc.description, '发送群消息');
  assert.equal((doc.inputSchema as { type?: unknown }).type, 'object');
});

test('describe() 覆盖的上下文不执行 action', () => {
  const registry = new ActionRegistry();
  let called = false;
  registry.register({
    name: 'no_exec_test',
    summary: '不会被调用',
    run: async () => {
      called = true;
      return null;
    },
  });

  registry.describe();
  assert.equal(called, false);
  // 保持 ActionContext 类型被使用，避免测试辅助函数被 lint 当成死代码。
  assert.equal(makeContext(makeBackend()).selfId, 10001);
});
