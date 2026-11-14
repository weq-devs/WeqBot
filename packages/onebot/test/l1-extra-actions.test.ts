/** 闪传 / 私聊文件链接 / 空间说说详情：注册、参数与字段名契约。 */

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

const flashStub: NonNullable<OneBotBackend['flashTransfer']> = {
  createTask: async (files, name) => ({
    filesetId: 'fs-1',
    shareUrl: `https://qfile.qq.com/q/code?n=${files.length}&name=${name ?? ''}`,
  }),
  getFilesetInfo: async (filesetId) => [
    {
      filesetId,
      fileName: 'a.pdf',
      origName: 'a.pdf',
      fileSize: 12,
      shareUrl: 'https://qfile.qq.com/q/code',
      fileId: 'fid',
      downloadUrl: 'https://cdn/thumb',
    },
  ],
  listFilesets: async () => [],
  getShareLink: async () => 'https://qfile.qq.com/q/code',
  deleteFile: async () => {},
  renameFile: async () => {},
  sendFlashMsg: async () => {},
  getFilesetIdByCode: async () => '11111111-2222-3333-4444-555555555555',
};

test('没有 flashTransfer 能力时闪传 action 全部跳过', async () => {
  const registry = new ActionRegistry();
  const { skipped } = registerActions(registry, makeBackend());
  for (const name of [
    'create_flash_task',
    'get_fileset_info',
    'get_flash_file_list',
    'list_filesets',
    'get_share_link',
    'delete_flash_file',
    'rename_flash_file',
    'send_flash_msg',
    'get_fileset_id',
  ]) {
    assert.ok(skipped.includes(name));
  }
  const response = await registry.call('list_filesets', {}, makeContext(makeBackend()));
  assert.equal(response.retcode, 1404);
});

test('create_flash_task 接受路径 / {file,name} / 数组，返回兼容双 id', async () => {
  let received: unknown = null;
  const backend = makeBackend({
    flashTransfer: {
      ...flashStub,
      createTask: async (files, name, thumbPath) => {
        received = { files, name, thumbPath };
        return { filesetId: 'fs-1', shareUrl: 'https://qfile.qq.com/q/code' };
      },
    },
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);

  const response = await registry.call(
    'create_flash_task',
    {
      files: ['/tmp/a.pdf', { file: '/tmp/b.pdf', name: '报告.pdf' }],
      name: '资料包',
      thumb_path: '/tmp/t.png',
    },
    makeContext(backend),
  );
  assert.deepEqual(response.data, { fileset_id: 'fs-1', task_id: 'fs-1' });
  assert.deepEqual(received, {
    files: [{ path: '/tmp/a.pdf' }, { path: '/tmp/b.pdf', name: '报告.pdf' }],
    name: '资料包',
    thumbPath: '/tmp/t.png',
  });

  const empty = await registry.call('create_flash_task', { files: [] }, makeContext(backend));
  assert.equal(empty.retcode, 1400);
});

test('文件集字段名对齐 SnowLuma，send_flash_msg 返回 0 占位', async () => {
  const sends: unknown[] = [];
  const backend = makeBackend({
    flashTransfer: {
      ...flashStub,
      sendFlashMsg: async (id, target) => {
        sends.push({ id, target });
      },
    },
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);

  const info = await registry.call(
    'get_fileset_info',
    { fileset_id: 'fs-1' },
    makeContext(backend),
  );
  assert.deepEqual(info.data, {
    fileset_id: 'fs-1',
    file_list: [
      {
        fileset_id: 'fs-1',
        file_name: 'a.pdf',
        orig_name: 'a.pdf',
        size: 12,
        share_url: 'https://qfile.qq.com/q/code',
        file_id: 'fid',
        download_url: 'https://cdn/thumb',
      },
    ],
  });

  const link = await registry.call('get_share_link', { fileset_id: 'fs-1' }, makeContext(backend));
  assert.equal(link.data, 'https://qfile.qq.com/q/code');

  const sent = await registry.call(
    'send_flash_msg',
    { fileset_id: 'fs-1', group_id: 20001 },
    makeContext(backend),
  );
  assert.deepEqual(sent.data, { message_id: 0 });
  assert.deepEqual(sends, [{ id: 'fs-1', target: { groupId: 20001 } }]);

  const missing = await registry.call(
    'send_flash_msg',
    { fileset_id: 'fs-1' },
    makeContext(backend),
  );
  assert.equal(missing.retcode, 1400);
});

test('get_fileset_id 透传分享码并返回 fileset_id', async () => {
  let code = '';
  const backend = makeBackend({
    flashTransfer: {
      ...flashStub,
      getFilesetIdByCode: async (value) => {
        code = value;
        return 'fs-uuid';
      },
    },
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);
  const response = await registry.call(
    'get_fileset_id',
    { share_code: 'https://qfile.qq.com/q/abc' },
    makeContext(backend),
  );
  assert.deepEqual(response.data, { fileset_id: 'fs-uuid' });
  assert.equal(code, 'https://qfile.qq.com/q/abc');
});

test('get_private_file_url 只要求 file_id，返回 url', async () => {
  let received: unknown = null;
  const backend = makeBackend({
    groupFile: {
      ...({} as NonNullable<OneBotBackend['groupFile']>),
      getPrivateFileUrl: async (userId, fileId, fileHash) => {
        received = { userId, fileId, fileHash };
        return 'https://cdn/private';
      },
    },
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);
  const response = await registry.call(
    'get_private_file_url',
    { file_id: 'fid' },
    makeContext(backend),
  );
  assert.deepEqual(response.data, { url: 'https://cdn/private' });
  assert.deepEqual(received, { userId: undefined, fileId: 'fid', fileHash: '' });
});

test('get_qzone_msg_detail 透传 tid / 目标 / 分页', async () => {
  let received: unknown = null;
  const backend = makeBackend({
    qzone: {
      ...({} as NonNullable<OneBotBackend['qzone']>),
      getMsgDetail: async (targetUin, tid, pos, num) => {
        received = { targetUin, tid, pos, num };
        return {
          tid,
          content: '正文',
          comment_num: 0,
          comments: [],
        };
      },
    },
  });
  const registry = new ActionRegistry();
  registerActions(registry, backend);
  const response = await registry.call(
    'get_qzone_msg_detail',
    { tid: 'T1', target_uin: 10002, pos: 5, num: 10 },
    makeContext(backend),
  );
  assert.equal(response.status, 'ok');
  assert.deepEqual(received, { targetUin: 10002, tid: 'T1', pos: 5, num: 10 });
  assert.deepEqual(response.data, {
    tid: 'T1',
    content: '正文',
    comment_num: 0,
    comments: [],
  });

  const blank = await registry.call('get_qzone_msg_detail', { tid: ' ' }, makeContext(backend));
  assert.equal(blank.retcode, 1400);
});
