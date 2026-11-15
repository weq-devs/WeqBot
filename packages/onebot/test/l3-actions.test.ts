/** 收藏 / 闪传直链 / 群相册 / 群分享链接 / rkey / 小程序卡片 / bot_exit。 */

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

function registryFor(backend: OneBotBackend): ActionRegistry {
  const registry = new ActionRegistry();
  registerActions(registry, backend);
  return registry;
}

test('get_collection_list 透传 category / count，默认 0 / 50', async () => {
  const calls: unknown[] = [];
  const backend = makeBackend({
    collection: {
      list: async (category, count) => {
        calls.push({ category, count });
        return { errCode: 0, errMsg: '', collectionSearchList: {} };
      },
    },
  });
  const registry = registryFor(backend);
  const context = makeContext(backend);

  assert.deepEqual((await registry.call('get_collection_list', {}, context)).data, {
    errCode: 0,
    errMsg: '',
    collectionSearchList: {},
  });
  await registry.call('get_collection_list', { category: 7, count: 20 }, context);
  assert.deepEqual(calls, [
    { category: 0, count: 50 },
    { category: 7, count: 20 },
  ]);

  const invalid = await registry.call('get_collection_list', { count: 501 }, context);
  assert.equal(invalid.retcode, 1400);
});

test('闪传两个 action 透传 file_index 并返回同形字段', async () => {
  const calls: unknown[] = [];
  const backend = makeBackend({
    flashTransfer: {
      createTask: async () => ({ filesetId: '', shareUrl: '' }),
      getFilesetInfo: async () => [],
      listFilesets: async () => [],
      getShareLink: async () => '',
      deleteFile: async () => {},
      renameFile: async () => {},
      sendFlashMsg: async () => {},
      getFilesetIdByCode: async () => '',
      getFileUrl: async (filesetId, fileIndex) => {
        calls.push({ filesetId, fileIndex });
        return 'https://example.com/a';
      },
      downloadFileset: async (filesetId, fileIndex) => {
        calls.push({ filesetId, fileIndex });
        return { url: 'https://example.com/b', fileName: 'b.mp4', fileSize: 123 };
      },
    },
  });
  const registry = registryFor(backend);
  const context = makeContext(backend);

  assert.deepEqual(
    (await registry.call('get_flash_file_url', { fileset_id: 'f1', file_index: 2 }, context)).data,
    { url: 'https://example.com/a' },
  );
  assert.deepEqual((await registry.call('download_fileset', { fileset_id: 'f1' }, context)).data, {
    url: 'https://example.com/b',
    file_name: 'b.mp4',
    file_size: 123,
  });
  assert.deepEqual(calls, [
    { filesetId: 'f1', fileIndex: 2 },
    { filesetId: 'f1', fileIndex: 1 },
  ]);
});

test('群相册：列表套 NapCat 封套；视频缺省使用占位 JPEG', async () => {
  let uploaded: Record<string, unknown> | undefined;
  const backend = makeBackend({
    groupAlbum: {
      listAlbums: async () => [
        {
          id: 'a1',
          name: '相册',
          picNum: 3,
          createTime: 100,
          last_upload_time: 200,
          cover: null,
          createuin: '10001',
          createnickname: 'bot',
        },
      ],
      uploadImage: async () => ({ session: '' }),
      uploadVideo: async (params) => {
        uploaded = params as unknown as Record<string, unknown>;
        return { videoId: 'v1' };
      },
      listMedia: async () => ({ mediaList: [], nextAttachInfo: '' }),
      comment: async () => {},
      setLike: async () => ({ id: null, status: null }),
      deleteMedia: async () => {},
    },
  });
  const registry = registryFor(backend);
  const context = makeContext(backend);

  assert.deepEqual((await registry.call('get_qun_album_list', { group_id: 20001 }, context)).data, {
    album_list: [
      {
        album_id: 'a1',
        name: '相册',
        create_time: '100',
        last_upload_time: '200',
        upload_number: '3',
        cover: null,
        creator: { uin: '10001', uid: '', nick: 'bot' },
      },
    ],
    attach_info: '',
    has_more: false,
  });

  const result = await registry.call(
    'upload_video_to_qun_album',
    {
      group_id: 20001,
      album_id: 'a1',
      album_name: '相册',
      file: Buffer.from('video-bytes').toString('base64'),
      duration: 5000,
      width: 640,
      height: 360,
    },
    context,
  );
  assert.deepEqual(result.data, { id: 'v1' });
  const cover = uploaded?.cover as Uint8Array;
  assert.equal(cover[0], 0xff);
  assert.equal(cover[1], 0xd8);
  assert.equal(uploaded?.durationMs, 5000);
  assert.equal(uploaded?.width, 640);
  assert.equal(uploaded?.height, 360);
});

test('get_group_share_link / get_rkey_server / get_mini_app_ark 参数映射', async () => {
  const shared: unknown[] = [];
  const backend = makeBackend({
    contactsExtra: {
      getFriendCategories: async () => [],
      setFriendCategory: async () => {},
      getRecommendArk: async () => '',
      getGroupShareLink: async (params) => {
        shared.push(params);
        return 'https://qm.qq.com/q/abc';
      },
      sendTuwenArk: async () => ({
        peerType: 0,
        targetId: 0,
        errorCode: 0,
        errorMessage: '',
      }),
    },
    rkey: {
      getDownloadRkeys: async () => [
        { type: 10, rkey: 'priv', ttlSeconds: 600 },
        { type: 20, rkey: 'group', ttlSeconds: 300 },
      ],
    },
    misc: {
      requestDecryptKey: async () => '',
      getMiniAppArk: async (params) => ({ data: params }),
    },
  });
  const registry = registryFor(backend);
  const context = makeContext(backend);

  assert.deepEqual(
    (await registry.call('get_group_share_link', { group_id: 20001 }, context)).data,
    { url: 'https://qm.qq.com/q/abc' },
  );
  assert.deepEqual(shared, [
    { groupId: 20001, needShortUrl: true, srcId: 73, additionalParam: '' },
  ]);

  const rkey = await registry.call('get_rkey_server', {}, context);
  const data = rkey.data as Record<string, unknown>;
  assert.equal(data.private_rkey, 'priv');
  assert.equal(data.group_rkey, 'group');
  assert.equal(data.name, 'WeqBot');
  assert.ok(Number(data.expired_time) > Math.floor(Date.now() / 1000));

  assert.deepEqual(
    (
      await registry.call(
        'get_mini_app_ark',
        { type: 'weibo', title: 't', pic_url: 'p', jumpUrl: 'j' },
        context,
      )
    ).data,
    {
      data: { type: 'weibo', title: 't', desc: '', picUrl: 'p', jumpUrl: 'j' },
    },
  );
  assert.equal((await registry.call('get_mini_app_ark', { type: 'other' }, context)).retcode, 1400);
});

test('bot_exit 只触发优雅下线，不等同于退出进程', async () => {
  let reason = '';
  const backend = makeBackend({
    botControl: {
      shutdown: async (value) => {
        reason = value;
      },
    },
  });
  const registry = registryFor(backend);
  const response = await registry.call('bot_exit', {}, makeContext(backend));
  assert.equal(response.retcode, 0);
  assert.equal(response.data, null);
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.equal(reason, 'bot-exit');
});
