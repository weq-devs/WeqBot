/**
 * 群相册媒体列表（trpc `QunMedia.GetMediaList`）的响应形状。
 *
 * 离线用例：用 `encode` + 生产 schema 造回包，再走 `decode`。验的是 WeQ 侧依赖
 * 的三块字段真的会被解出来 —— 它们曾经在搬入时退化成 `fieldN` 占位，导致调用方
 * 静默拿不到失败码、相册权限和实况位（wire type 不匹配会被 decode 直接跳过）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GET_MEDIA_LIST_RESPONSE } from '../src/oidb/media-schemas';
import { decode, encode, message } from '../src/protobuf';

type Decoded = {
  result?: number;
  errorMessage?: string;
  data?: {
    albumInfo?: { albumId?: string; name?: string };
    mediaList?: Array<Record<string, unknown>>;
    nextAttachInfo?: string;
    right?: { operations?: number[]; normalUpload?: boolean };
  };
};

test('失败码与错误文案按 int32 / string 解出，不再被当成 bytes 跳过', () => {
  const body = encode(GET_MEDIA_LIST_RESPONSE, {
    field1: 42,
    result: 5,
    errorMessage: 'permission denied',
    data: {},
  });
  const decoded = decode(GET_MEDIA_LIST_RESPONSE, body) as Decoded;
  assert.equal(decoded.result, 5);
  assert.equal(decoded.errorMessage, 'permission denied');
});

test('逐相册操作能力是编号列表', () => {
  const body = encode(GET_MEDIA_LIST_RESPONSE, {
    result: 0,
    data: { albumInfo: { albumId: 'album', name: '相册' }, right: { operations: [2, 3] } },
  });
  const decoded = decode(GET_MEDIA_LIST_RESPONSE, body) as Decoded;
  assert.deepEqual(decoded.data?.right?.operations, [2, 3]);
  assert.equal(decoded.data?.albumInfo?.albumId, 'album');
});

test('实况位缺失时不补 false，与显式 false 区分开', () => {
  // 显式 false 只有在发送端把它写进 wire 时才可见（本包的 schema 只用于解码，
  // isLivePhoto 不是 force）；这里用 force 的旁路 schema 复刻真机写法。
  const server = message([
    {
      name: 'data',
      tag: 4,
      type: message([
        {
          name: 'mediaList',
          tag: 3,
          repeated: true,
          type: message([
            { name: 'type', tag: 1, type: 'uint32' },
            { name: 'live', tag: 18, type: 'bool', force: true },
          ]),
        },
      ]),
    },
  ]);
  const bytes = encode(server, {
    data: { mediaList: [{ type: 1, live: true }, { type: 1, live: false }, { type: 1 }] },
  });
  // 第三条在旁路 schema 里仍是 force，会被写成 false —— 单独去掉它再造一次。
  const missing = encode(server, {
    data: {
      mediaList: [
        { type: 1, live: true },
        { type: 1, live: false },
      ],
    },
  });
  const mediaList = (decode(GET_MEDIA_LIST_RESPONSE, bytes) as Decoded).data?.mediaList ?? [];
  assert.equal(mediaList[0]?.isLivePhoto, true);
  assert.equal(mediaList[1]?.isLivePhoto, false);

  const withoutFlag = encode(server, { data: { mediaList: [{ type: 1 }] } });
  const absent = (decode(GET_MEDIA_LIST_RESPONSE, withoutFlag) as Decoded).data?.mediaList ?? [];
  assert.equal('isLivePhoto' in (absent[0] ?? {}), false);
  // 两条消息的长度不同：显式 false 会多出 tag18 的两个字节。
  assert.ok(bytes.length > missing.length);
});

test('同 tag 的非布尔 wire 不会被当成实况标记', () => {
  // 服务端若在该 tag 上放别的类型，decode 按 wire type 跳过，不该伪造出 flag。
  // 用一份只把 tag 18 变成 string 的旁路 schema 造字节，再拿生产 schema 解。
  const foreign = message([
    {
      name: 'data',
      tag: 4,
      type: message([
        {
          name: 'mediaList',
          tag: 3,
          repeated: true,
          type: message([{ name: 'live', tag: 18, type: 'string' }]),
        },
      ]),
    },
  ]);
  const bytes = encode(foreign, { data: { mediaList: [{ live: 'not a flag' }] } });
  assert.equal(
    'isLivePhoto' in
      ((decode(GET_MEDIA_LIST_RESPONSE, bytes) as Decoded).data?.mediaList?.[0] ?? {}),
    false,
  );
});

test('分页游标原样透出', () => {
  const body = encode(GET_MEDIA_LIST_RESPONSE, {
    result: 0,
    data: { nextAttachInfo: 'next-page-token' },
  });
  assert.equal(
    (decode(GET_MEDIA_LIST_RESPONSE, body) as Decoded).data?.nextAttachInfo,
    'next-page-token',
  );
});
