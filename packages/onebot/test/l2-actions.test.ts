/** L2 低成本项：文件上传、收藏表情、输入状态、内联按钮、禁言列表。 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { ActionRegistry, type ActionContext } from '../src/action-registry';
import { registerActions } from '../src/actions';
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

const groupFileStub: NonNullable<OneBotBackend['groupFile']> = {
  uploadGroupFile: async () => ({ fileId: 'gf-1', fileName: 'a.pdf', fileSize: 3 }),
  uploadPrivateFile: async () => ({ fileId: 'pf-1' }),
  listGroupFiles: async () => ({ files: [], folders: [], total: 0 }),
  getGroupFileUrl: async () => '',
  getPrivateFileUrl: async () => '',
  getGroupFileCount: async () => ({ fileCount: 0, maxCount: 0, isFull: false }),
  getGroupFileSpace: async () => ({ usedSpace: 0, totalSpace: 0 }),
  deleteGroupFile: async () => {},
  renameGroupFile: async () => {},
  moveGroupFile: async () => {},
  createGroupFolder: async () => '',
  deleteGroupFolder: async () => {},
  renameGroupFolder: async () => {},
};

test('上传群文件 / 私聊文件：剥 file://、拒绝远程 URL、返回 file_id', async () => {
  const calls: unknown[] = [];
  const backend = makeBackend({
    groupFile: {
      ...groupFileStub,
      uploadGroupFile: async (params) => {
        calls.push(params);
        return { fileId: 'gf-1', fileName: 'a.pdf', fileSize: 3 };
      },
      uploadPrivateFile: async (params) => {
        calls.push(params);
        return { fileId: 'pf-1' };
      },
    },
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);

  const group = await registry.call(
    'upload_group_file',
    { group_id: 20001, file: 'file:///tmp/a.pdf', name: 'a.pdf', folder: '/docs' },
    makeContext(backend),
  );
  assert.deepEqual(group.data, { file_id: 'gf-1' });

  const priv = await registry.call(
    'upload_private_file',
    { user_id: 10002, file: '/tmp/b.pdf', upload_file: false },
    makeContext(backend),
  );
  assert.deepEqual(priv.data, { file_id: 'pf-1' });
  assert.deepEqual(calls, [
    { groupId: 20001, filePath: '/tmp/a.pdf', fileName: 'a.pdf', folderId: '/docs', publish: true },
    { userId: 10002, filePath: '/tmp/b.pdf', fileName: undefined, send: false },
  ]);

  const remote = await registry.call(
    'upload_group_file',
    { group_id: 20001, file: 'https://example.com/a.pdf' },
    makeContext(backend),
  );
  assert.equal(remote.retcode, 1400);
});

test('add_custom_face 支持本机路径与 base64', async () => {
  const calls: unknown[] = [];
  const backend = makeBackend({
    customFace: {
      addCustomFace: async (source) => {
        calls.push(source);
        return 'emoji-1';
      },
      listCustomFaces: async () => [],
      getCustomFaceDetail: async () => [],
      modifyCustomFace: async () => {},
      moveCustomFaceToFront: async () => {},
      deleteCustomFace: async () => {},
      resolveCustomFaceUrl: async () => ({ emojiId: '', md5: '', url: '' }),
    },
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);

  const path = await registry.call('add_custom_face', { file: '/tmp/e.png' }, makeContext(backend));
  const inline = await registry.call(
    'add_custom_face',
    { file: `base64://${Buffer.from('png').toString('base64')}` },
    makeContext(backend),
  );
  assert.deepEqual(path.data, { emoji_id: 'emoji-1' });
  assert.deepEqual(inline.data, { emoji_id: 'emoji-1' });
  assert.equal(calls[0], '/tmp/e.png');
  assert.deepEqual(calls[1], new Uint8Array(Buffer.from('png')));
});

test('set_self_longnick / set_input_status / 内联按钮参数映射', async () => {
  const calls: unknown[] = [];
  const backend = makeBackend({
    profile: {
      setProfile: async () => {},
      setAvatar: async () => {},
      getProfileLike: async () => {
        throw new Error('not used');
      },
      setOnlineStatus: async () => {},
      setDiyOnlineStatus: async () => {},
      setSelfLongNick: async (longNick) => {
        calls.push({ longNick });
      },
      setInputStatus: async (userId, eventType) => {
        calls.push({ userId, eventType });
      },
    },
    interactionExtra: {
      getEmojiLikes: async () => ({ users: [], cookie: '', isLast: true }),
      setReaction: async () => {},
      sendGroupSign: async () => {},
      listSystemFaces: async () => [],
      getSystemFace: async () => null,
      translateEn2Zh: async (words) => words,
      clickInlineButton: async (params) => {
        calls.push(params);
        return { result: 0, errMsg: '', promptText: 'ok' };
      },
    },
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);

  assert.deepEqual(
    (await registry.call('set_self_longnick', { long_nick: '学习' }, makeContext(backend))).data,
    {},
  );
  assert.deepEqual(
    (await registry.call('set_input_status', { user_id: 10002 }, makeContext(backend))).data,
    {},
  );
  const click = await registry.call(
    'click_inline_keyboard_button',
    {
      group_id: 20001,
      bot_appid: 10001,
      msg_seq: 42,
      button_id: 'b1',
      callback_data: 'c1',
    },
    makeContext(backend),
  );
  assert.deepEqual(click.data, {
    result: 0,
    errMsg: '',
    promptText: 'ok',
    status: 0,
    promptType: 0,
    promptIcon: 0,
  });
  assert.deepEqual(calls, [
    { longNick: '学习' },
    { userId: 10002, eventType: 0 },
    {
      groupId: 20001,
      botAppid: 10001,
      msgSeq: 42,
      buttonId: 'b1',
      callbackData: 'c1',
    },
  ]);
});

test('被过滤的入群请求映射成 SnowLuma / NapCat 两套字段', async () => {
  const backend = makeBackend({
    groupAdminExtra: {
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
      getIgnoredGroupRequests: async () => [
        {
          groupId: 20001,
          groupName: '群',
          sequence: 7,
          targetUin: 10002,
          targetName: '申请人',
          invitorUin: 0,
          invitorName: '',
          operatorUin: 0,
          operatorName: '',
          comment: '进群',
          checked: false,
          flag: 'slreq:1:7:20001:1:1',
        },
      ],
      getGroupSystemMessages: async () => [],
      setGroupSearch: async () => {},
      setMemberInvitePolicy: async () => {},
      setNewMemberHistoryVisibility: async () => {},
      setMemberPermissions: async () => {},
      getGroupAdminSettings: async () => {
        throw new Error('not used');
      },
    },
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);

  const notifies = await registry.call('get_group_ignored_notifies', {}, makeContext(backend));
  assert.deepEqual(notifies.data, [
    {
      group_id: 20001,
      group_name: '群',
      request_id: 7,
      requester_uin: 10002,
      requester_nick: '申请人',
      message: '进群',
      checked: false,
      actor: 0,
      invitor_uin: 0,
      invitor_nick: '',
      flag: 'slreq:1:7:20001:1:1',
    },
  ]);

  const addRequest = await registry.call('get_group_ignore_add_request', {}, makeContext(backend));
  assert.deepEqual(addRequest.data, [
    {
      request_id: 7,
      invitor_uin: 0,
      invitor_nick: '',
      group_id: 20001,
      message: '进群',
      group_name: '群',
      checked: false,
      actor: 0,
      requester_nick: '申请人',
    },
  ]);
});

test('get_group_shut_list 只保留未到期成员；fetch_super_face_id 查目录', async () => {
  const now = Math.floor(Date.now() / 1000);
  const backend = makeBackend({
    getGroupMemberList: async (groupId) => [
      {
        groupId,
        userId: 10002,
        nickname: 'a',
        card: '',
        sex: 'unknown',
        age: 0,
        area: '',
        joinTime: 0,
        lastSentTime: 0,
        level: '0',
        role: 'member',
        title: '',
        shutUpTime: now + 600,
      },
      {
        groupId,
        userId: 10003,
        nickname: 'b',
        card: '',
        sex: 'unknown',
        age: 0,
        area: '',
        joinTime: 0,
        lastSentTime: 0,
        level: '0',
        role: 'member',
        title: '',
        shutUpTime: now - 1,
      },
    ],
    interactionExtra: {
      getEmojiLikes: async () => ({ users: [], cookie: '', isLast: true }),
      setReaction: async () => {},
      sendGroupSign: async () => {},
      listSystemFaces: async () => [
        { faceId: 14, name: '微笑', isSuper: true },
        { faceId: 1, name: '撇嘴', isSuper: false },
      ],
      getSystemFace: async () => null,
      translateEn2Zh: async (words) => words,
      clickInlineButton: async () => ({ result: 0, errMsg: '', promptText: '' }),
    },
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);

  const shut = await registry.call(
    'get_group_shut_list',
    { group_id: 20001 },
    makeContext(backend),
  );
  assert.deepEqual(shut.data, [{ user_id: 10002, nickname: 'a', shut_up_time: now + 600 }]);

  const superFace = await registry.call(
    'fetch_super_face_id',
    { face_id: 14 },
    makeContext(backend),
  );
  assert.deepEqual(superFace.data, { is_super: true });
  const normal = await registry.call('fetch_super_face_id', { face_id: 1 }, makeContext(backend));
  assert.deepEqual(normal.data, { is_super: false });
});
