/** 空间说说投稿/收录状态（SetFeedStatus）请求与回执（离线）。 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decode, encode, message } from '../src/protobuf';
import { SetQzoneFeedStatus } from '../src/qzone/feed-status';

const request = message([
  { name: 'id', tag: 1, type: 'string' },
  {
    name: 'status',
    tag: 2,
    type: message([
      { name: 'kind', tag: 1, type: 'int32' },
      { name: 'action', tag: 2, type: 'uint32' },
    ]),
    repeated: true,
  },
  { name: 'owner', tag: 3, type: 'string' },
  { name: 'actor', tag: 4, type: 'string' },
]);
const response = message([
  { name: 'outerCode', tag: 2, type: 'uint64' },
  {
    name: 'body',
    tag: 4,
    type: message([
      { name: 'code', tag: 1, type: 'int32', force: true },
      { name: 'msg', tag: 2, type: 'string' },
    ]),
  },
]);

test('按 SDK 字段发送三种操作，不直接写 archiveStatus', () => {
  const cases = [
    ['contribute', 19, 1],
    ['uncontribute', 19, 2],
    ['unarchive', 6, 2],
  ] as const;
  for (const [action, kind, value] of cases) {
    const encoded = SetQzoneFeedStatus.serialize({
      selfUin: '10001',
      feedId: 'native-id',
      action,
    });
    assert.deepEqual(decode(request, encoded.body), {
      id: 'native-id',
      owner: '10001',
      actor: '10001',
      status: [{ kind, action: value }],
    });
  }
});

test('外层、业务错误与缺失回执均不视为成功', () => {
  assert.deepEqual(SetQzoneFeedStatus.parse(encode(response, { body: { code: 0 } })), {
    accepted: true,
  });
  assert.throws(
    () =>
      SetQzoneFeedStatus.parse(
        encode(response, { body: { code: 14001, msg: 'synthetic refusal' } }),
      ),
    /synthetic refusal/,
  );
  assert.throws(() =>
    SetQzoneFeedStatus.parse(encode(response, { outerCode: 1n, body: { code: 0 } })),
  );
  assert.throws(() => SetQzoneFeedStatus.parse(new Uint8Array()));
});

test('目标无效时在发包前拒绝', () => {
  for (const params of [
    { selfUin: '10001', feedId: '', action: 'contribute' as const },
    { selfUin: '10001', feedId: 'x'.repeat(1025), action: 'contribute' as const },
    { selfUin: '1000', feedId: 'ok', action: 'contribute' as const },
    { selfUin: '10001', feedId: 'ok', action: 'nope' as never },
  ])
    assert.throws(() => SetQzoneFeedStatus.serialize(params));
});
