/** 群管理细项（L1 第 5 批）：参数归一、字段名与能力注册。 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { ActionRegistry, type ActionContext } from '../src/action-registry';
import { registerActions } from '../src/actions';
import type { GroupAdminExtraBackend, OneBotBackend } from '../src/backend';

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

const NICHE_ACTIONS = [
  'set_group_kick_members',
  'set_group_add_option',
  'get_group_tags',
  'add_group_tag',
  'delete_group_tag',
  'get_group_admin_permissions',
  'set_group_admin_permissions',
  'set_group_admin_receive_verify',
  'set_group_robot_add_option',
  'set_group_portrait',
  'get_group_system_msg',
  'set_group_search',
  'set_group_member_invite_policy',
  'set_group_new_member_history_visibility',
  'set_group_member_permissions',
  'get_group_admin_settings',
];

test('没有 groupAdminExtra 时群管理细项全部跳过', async () => {
  const registry = new ActionRegistry();
  const { skipped } = registerActions(registry, makeBackend());
  for (const name of NICHE_ACTIONS) assert.ok(skipped.includes(name), name);
  const response = await registry.call('get_group_system_msg', {}, makeContext(makeBackend()));
  assert.equal(response.retcode, 1404);
});

function extraStub(overrides: Partial<GroupAdminExtraBackend> = {}): GroupAdminExtraBackend {
  return {
    setGroupRemark: async () => {},
    getGroupInfoEx: async () => {
      throw new Error('not used');
    },
    kickMembers: async () => {},
    setAddOption: async () => {},
    listCategoryTags: async () => [],
    addCategoryTag: async () => {},
    removeCategoryTag: async () => {},
    getAdminPermissions: async () => ({
      recall_member_message: null,
      kick_member: null,
      kick_member_per_day: null,
    }),
    setAdminPermissions: async () => {},
    setAdminReceiveVerify: async () => {},
    setRobotAddOption: async () => {},
    setGroupAvatar: async () => {},
    getGroupSystemMessages: async () => [],
    setGroupSearch: async () => {},
    setMemberInvitePolicy: async () => {},
    setNewMemberHistoryVisibility: async () => {},
    setMemberPermissions: async () => {},
    getGroupAdminSettings: async () => ({
      add_type: 0,
      group_question: '',
      group_answer: '',
      robot_member_switch: 0,
      robot_member_examine: 0,
      member_invite_policy: 'require_approval',
      allow_member_upload_album: true,
      allow_member_temporary_session: true,
      allow_member_create_group: true,
      new_member_history_visible: true,
      no_finger_open: 0,
      no_code_finger_open: 0,
    }),
    ...overrides,
  };
}

test('批量踢人接受单值 / 数组 / 数字字符串，透传 reject', async () => {
  const calls: unknown[] = [];
  const backend = makeBackend({
    groupAdminExtra: extraStub({
      kickMembers: async (groupId, userIds, reject) => {
        calls.push({ groupId, userIds, reject });
      },
    }),
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);

  const response = await registry.call(
    'set_group_kick_members',
    { group_id: 20001, user_id: [10002, '10003'], reject_add_request: true },
    makeContext(backend),
  );
  assert.equal(response.status, 'ok');
  assert.deepEqual(calls, [{ groupId: 20001, userIds: [10002, 10003], reject: true }]);

  const empty = await registry.call(
    'set_group_kick_members',
    { group_id: 20001, user_id: [] },
    makeContext(backend),
  );
  assert.equal(empty.retcode, 1400);
});

test('set_group_add_option 缺省 add_type=0，问题与答案原样透传', async () => {
  let received: unknown = null;
  const backend = makeBackend({
    groupAdminExtra: extraStub({
      setAddOption: async (params) => {
        received = params;
      },
    }),
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);

  await registry.call(
    'set_group_add_option',
    { group_id: 20001, group_question: '来干嘛', group_answer: '学习' },
    makeContext(backend),
  );
  assert.deepEqual(received, {
    groupId: 20001,
    addType: 0,
    groupQuestion: '来干嘛',
    groupAnswer: '学习',
  });
});

test('群标签：读返回 tags，增删都要求非空标签名', async () => {
  const calls: unknown[] = [];
  const backend = makeBackend({
    groupAdminExtra: extraStub({
      listCategoryTags: async (groupClass) => {
        calls.push({ op: 'list', groupClass });
        return [{ id: 1, name: '学习', type: 2 }];
      },
      addCategoryTag: async (groupClass, name) => {
        calls.push({ op: 'add', groupClass, name });
      },
      removeCategoryTag: async (groupClass, name) => {
        calls.push({ op: 'delete', groupClass, name });
      },
    }),
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);

  const tags = await registry.call('get_group_tags', { group_class: 0 }, makeContext(backend));
  assert.deepEqual(tags.data, { tags: [{ id: 1, name: '学习', type: 2 }] });
  await registry.call('add_group_tag', { group_class: 3, name: ' 社团 ' }, makeContext(backend));
  await registry.call('delete_group_tag', { group_class: 3, name: '社团' }, makeContext(backend));

  assert.deepEqual(calls, [
    { op: 'list', groupClass: 0 },
    { op: 'add', groupClass: 3, name: '社团' },
    { op: 'delete', groupClass: 3, name: '社团' },
  ]);

  const blank = await registry.call(
    'add_group_tag',
    { group_class: 3, name: '  ' },
    makeContext(backend),
  );
  assert.equal(blank.retcode, 1400);
});

test('管理员权限：读取三态，写入校验每日上限', async () => {
  const writes: unknown[] = [];
  const backend = makeBackend({
    groupAdminExtra: extraStub({
      getAdminPermissions: async () => ({
        recall_member_message: true,
        kick_member: false,
        kick_member_per_day: null,
      }),
      setAdminPermissions: async (params) => {
        writes.push(params);
      },
    }),
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);

  const read = await registry.call(
    'get_group_admin_permissions',
    { group_id: 20001, user_id: 10002 },
    makeContext(backend),
  );
  assert.deepEqual(read.data, {
    group_id: 20001,
    user_id: 10002,
    recall_member_message: true,
    kick_member: false,
    kick_member_per_day: null,
  });

  await registry.call(
    'set_group_admin_permissions',
    {
      group_id: 20001,
      user_id: 10002,
      recall_member_message: false,
      kick_member: true,
      kick_member_per_day: 10,
    },
    makeContext(backend),
  );
  assert.deepEqual(writes, [
    {
      groupId: 20001,
      userId: 10002,
      recallMemberMessage: false,
      kickMember: true,
      kickMemberPerDay: 10,
    },
  ]);

  for (const params of [
    { group_id: 20001, user_id: 10002, kick_member: true },
    { group_id: 20001, user_id: 10002, kick_member: true, kick_member_per_day: 7 },
    { group_id: 20001, user_id: 10002, kick_member_per_day: 10 },
  ]) {
    const bad = await registry.call('set_group_admin_permissions', params, makeContext(backend));
    assert.equal(bad.retcode, 1400);
  }
});

test('接收验证必须显式 enable；机器人选项至少传一项', async () => {
  const calls: unknown[] = [];
  const backend = makeBackend({
    groupAdminExtra: extraStub({
      setAdminReceiveVerify: async (...args) => {
        calls.push(args);
      },
      setRobotAddOption: async (params) => {
        calls.push(params);
      },
    }),
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);

  await registry.call(
    'set_group_admin_receive_verify',
    { group_id: 20001, user_id: 10002, enable: false },
    makeContext(backend),
  );
  await registry.call(
    'set_group_robot_add_option',
    { group_id: 20001, robot_member_examine: 2 },
    makeContext(backend),
  );
  assert.deepEqual(calls, [
    [20001, 10002, false],
    { groupId: 20001, robotMemberSwitch: undefined, robotMemberExamine: 2 },
  ]);

  for (const [name, params] of [
    ['set_group_admin_receive_verify', { group_id: 20001, user_id: 10002 }],
    ['set_group_robot_add_option', { group_id: 20001 }],
  ] as const) {
    const bad = await registry.call(name, params, makeContext(backend));
    assert.equal(bad.retcode, 1400);
  }
});

test('群头像文件路径透传；系统消息原样返回', async () => {
  const calls: unknown[] = [];
  const message = {
    group_id: 20001,
    group_name: '测试群',
    request_id: 7,
    requester_uin: 10002,
    requester_nick: '申请人',
    target_uin: 10002,
    target_nick: '申请人',
    target_status: 'known' as const,
    invitor_uin: 0,
    invitor_nick: '',
    invitor_status: 'unknown' as const,
    operator_uin: 0,
    operator_nick: '',
    operator_status: 'unknown' as const,
    message: '想进群',
    checked: false,
    flag: 'slreq:1:7:20001:1:0',
  };
  const backend = makeBackend({
    groupAdminExtra: extraStub({
      setGroupAvatar: async (groupId, source) => {
        calls.push({ groupId, source });
      },
      getGroupSystemMessages: async (params) => {
        calls.push(params);
        return [message];
      },
    }),
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);

  await registry.call(
    'set_group_portrait',
    { group_id: 20001, file: '/tmp/avatar.png' },
    makeContext(backend),
  );
  const list = await registry.call(
    'get_group_system_msg',
    { group_id: 20001, only_pending: true, count: 10 },
    makeContext(backend),
  );
  assert.deepEqual(calls, [
    { groupId: 20001, source: '/tmp/avatar.png' },
    { groupId: 20001, onlyPending: true, count: 10 },
  ]);
  assert.deepEqual(list.data, [message]);

  const badCount = await registry.call(
    'get_group_system_msg',
    { count: 101 },
    makeContext(backend),
  );
  assert.equal(badCount.retcode, 1400);
});

test('群搜索 / 邀请策略 / 历史可见 / 成员权限参数映射', async () => {
  const calls: unknown[] = [];
  const backend = makeBackend({
    groupAdminExtra: extraStub({
      setGroupSearch: async (params) => {
        calls.push(params);
      },
      setMemberInvitePolicy: async (groupId, policy) => {
        calls.push({ groupId, policy });
      },
      setNewMemberHistoryVisibility: async (groupId, visible) => {
        calls.push({ groupId, visible });
      },
      setMemberPermissions: async (groupId, patch) => {
        calls.push({ groupId, patch });
      },
    }),
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);

  await registry.call(
    'set_group_search',
    { group_id: 20001, no_finger_open: 0, no_code_finger_open: 1 },
    makeContext(backend),
  );
  await registry.call(
    'set_group_member_invite_policy',
    { group_id: 20001, policy: 'no_approval' },
    makeContext(backend),
  );
  await registry.call(
    'set_group_new_member_history_visibility',
    { group_id: 20001, visible: false },
    makeContext(backend),
  );
  await registry.call(
    'set_group_member_permissions',
    { group_id: 20001, allow_member_create_group: false },
    makeContext(backend),
  );
  assert.deepEqual(calls, [
    { groupId: 20001, noFingerOpen: 0, noCodeFingerOpen: 1 },
    { groupId: 20001, policy: 'no_approval' },
    { groupId: 20001, visible: false },
    {
      groupId: 20001,
      patch: {
        allowMemberUploadAlbum: undefined,
        allowMemberTemporarySession: undefined,
        allowMemberCreateGroup: false,
      },
    },
  ]);

  for (const [name, params] of [
    ['set_group_search', { group_id: 20001 }],
    ['set_group_member_invite_policy', { group_id: 20001, policy: 'everyone' }],
    ['set_group_member_permissions', { group_id: 20001 }],
  ] as const) {
    const bad = await registry.call(name, params, makeContext(backend));
    assert.equal(bad.retcode, 1400, name);
  }
});

test('get_group_admin_settings 原样返回后端快照', async () => {
  const snapshot = {
    add_type: 4,
    group_question: '来干嘛',
    group_answer: '学习',
    robot_member_switch: 1,
    robot_member_examine: 2,
    member_invite_policy: 'require_approval' as const,
    allow_member_upload_album: false,
    allow_member_temporary_session: true,
    allow_member_create_group: false,
    new_member_history_visible: true,
    no_finger_open: 0,
    no_code_finger_open: 1,
  };
  const backend = makeBackend({
    groupAdminExtra: extraStub({ getGroupAdminSettings: async () => snapshot }),
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);
  const response = await registry.call(
    'get_group_admin_settings',
    { group_id: 20001 },
    makeContext(backend),
  );
  assert.deepEqual(response.data, snapshot);
});
