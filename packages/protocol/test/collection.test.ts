/** 收藏 collector 信封 / 分页 / 字段映射（纯离线）。 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encode } from '../src/protobuf';
import { COLLECTION_RESP_BODY, COLLECTION_RESP_HEAD } from '../src/web/collection-schemas';
import { encodeCollectionEnvelope, getCollectionList } from '../src/web/collection';

function response(): Uint8Array {
  const head = encode(COLLECTION_RESP_HEAD, { retCode: 0, retMsg: 'ok' });
  const body = encode(COLLECTION_RESP_BODY, {
    operation: {
      getCollectionList: {
        items: [
          {
            cid: 'c1',
            type: 1,
            status: 0,
            author: { type: 1, numId: 10001n, strId: 'u', groupId: 0n, groupName: '', uid: 'u_1' },
            bid: 0,
            category: 2,
            createTime: 100n,
            collectTime: 101n,
            modifyTime: 102n,
            sequence: 1n,
            shareUrl: 'https://example.com',
            customGroupId: 0,
            securityBeat: false,
            summary: {
              textSummary: { text: 'hello', truncated: true },
              linkSummary: { url: 'https://example.com', title: 't' },
            },
          },
        ],
        reachedBottom: 1,
      },
    },
  });
  return encodeCollectionEnvelope(head, body);
}

test('收藏列表：校验信封、映射字段并保留 JSON 形状', async () => {
  let bodySeen: Uint8Array | undefined;
  const result = await getCollectionList({
    uin: '10001',
    pskey: 'PSKEY',
    count: 10,
    transport: async (request) => {
      bodySeen = request.body;
      assert.equal(request.url, 'https://collector.weiyun.com/collector.fcg');
      assert.match(request.headers.Cookie, /vt=27;vi=PSKEY;appid=5004/);
      return response();
    },
  });

  assert.ok(bodySeen);
  assert.deepEqual([...bodySeen.subarray(0, 4)], [0x20, 0x13, 0x03, 0x29]);
  assert.equal(result.errCode, 0);
  assert.equal(result.collectionSearchList.hasMore, false);
  assert.equal(result.collectionSearchList.bottomTimeStamp, '102');
  const [item] = result.collectionSearchList.collectionItemList;
  assert.equal(item?.cid, 'c1');
  assert.equal(item?.modifyTime, '102');
  assert.equal(item?.author.numId, '10001');
  assert.deepEqual(item?.summary.textSummary, { text: 'hello', truncated: true });
  assert.deepEqual(item?.summary.linkSummary, { url: 'https://example.com', title: 't' });
});

test('收藏列表：空 p_skey / 非法 count 直接报错', async () => {
  await assert.rejects(
    getCollectionList({ uin: '10001', pskey: '', transport: async () => response() }),
    /p_skey is empty/,
  );
  await assert.rejects(
    getCollectionList({ uin: '10001', pskey: 'x', count: 0, transport: async () => response() }),
    /count must be between/,
  );
});
