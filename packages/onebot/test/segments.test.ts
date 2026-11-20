/**
 * 元素 ⇄ segment 双向映射的回归测试。
 *
 * 重点不是覆盖每个字段，而是锁住两件容易漂的事：
 *   1. 收进来的元素能原样转成 segment（`kind` 与 segment type 的对应）；
 *   2. 发出去的 segment 能转回 `kind` 元素（发送路径用的就是这个方向）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { elementsToSegments, segmentsToElements, type InboundElement } from '../src/segments';

test('入站文本 / at / 表情 → segment', async () => {
  const elements: InboundElement[] = [
    { kind: 'text', textContent: '你好' },
    { kind: 'at', atTargetUin: 10001, textContent: '@某人 ' },
    { kind: 'face', faceId: 14 },
    {
      kind: 'emojiBounce',
      emojiBounceId: 182,
      emojiBounceName: '笑哭',
      emojiBounceTextSummary: '对方弹射了10个[笑哭]',
    },
  ];
  const segments = await elementsToSegments(elements, { isGroup: true, selfId: 1 });
  assert.deepEqual(segments, [
    { type: 'text', data: { text: '你好' } },
    { type: 'at', data: { qq: '10001' } },
    { type: 'face', data: { id: '14' } },
    { type: 'emoji_bounce', data: { face_id: 182, name: '笑哭', count: 10 } },
  ]);
});

test('@全体成员 走 all 分支', async () => {
  const segments = await elementsToSegments(
    [{ kind: 'at', all: true, textContent: '@全体成员 ' }],
    { isGroup: true, selfId: 1 },
  );
  assert.deepEqual(segments, [{ type: 'at', data: { qq: 'all' } }]);
});

test('图片优先用 resolver 给的 URL，缺省时回落到文件名', async () => {
  const segments = await elementsToSegments(
    [{ kind: 'pic', fileName: 'a.png', md5Bytes: new Uint8Array([0xab, 0xcd]) }],
    {
      isGroup: false,
      selfId: 1,
      imageUrlResolver: () => 'https://example.com/a.png',
    },
  );
  assert.equal(segments[0]?.data.url, 'https://example.com/a.png');
  assert.equal(segments[0]?.data.file, 'a.png');
});

test('未建模的 kind 直接跳过，不抛错', async () => {
  const segments = await elementsToSegments([{ kind: 'unknown-thing' }], {
    isGroup: true,
    selfId: 1,
  });
  assert.deepEqual(segments, []);
});

test('出站 segment → 元素：文本 / at / 表情', async () => {
  const elements = await segmentsToElements(
    [
      { type: 'text', data: { text: 'hi' } },
      { type: 'at', data: { qq: '10001', uid: 'u_abc' } },
      { type: 'face', data: { id: 14 } },
    ],
    {},
  );
  assert.deepEqual(elements, [
    { kind: 'text', textContent: 'hi' },
    { kind: 'at', atTargetUin: 10001, atTargetUid: 'u_abc' },
    { kind: 'face', faceId: 14 },
  ]);
});

test('出站 at 缺 uid 时用 resolver 补', async () => {
  const elements = await segmentsToElements([{ type: 'at', data: { qq: '10001' } }], {
    resolveMentionUid: () => 'u_resolved',
  });
  assert.equal(elements[0]?.atTargetUid, 'u_resolved');
});

test('出站未知 segment 明确报错（让调用方拿到 1400）', async () => {
  await assert.rejects(
    () => segmentsToElements([{ type: 'music', data: {} }]),
    /不支持发送的 segment 类型/,
  );
});

test('商城表情：出站 image 带 emoji_id 时还原成 mface', async () => {
  const elements = await segmentsToElements([
    { type: 'image', data: { emoji_id: 'abcdef0123', emoji_package_id: 7 } },
  ]);
  assert.equal(elements[0]?.kind, 'mface');
  assert.equal(elements[0]?.marketEmoticonId, 'abcdef0123');
  assert.equal(elements[0]?.emojiPackId, 7);
});
