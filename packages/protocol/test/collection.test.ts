/** 收藏 collector 信封 / 分页 / 字段映射（纯离线）。 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decode, encode } from '../src/protobuf';
import {
  COLLECTION_DOWNLOAD_REQ_HEAD,
  COLLECTION_DOWNLOAD_RESP_BODY,
  COLLECTION_DOWNLOAD_RESP_HEAD,
  COLLECTION_RESP_BODY,
  COLLECTION_RESP_HEAD,
} from '../src/web/collection-schemas';
import {
  encodeCollectionEnvelope,
  getCollectionDetails,
  getCollectionList,
  getCollectionPage,
} from '../src/web/collection';
import { applyCollectionFileDownload } from '../src/web/collection-download';

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

function envelope(
  body: Record<string, unknown>,
  head: Record<string, unknown> = { retCode: 0, retMsg: 'ok' },
): Uint8Array {
  return encodeCollectionEnvelope(
    encode(COLLECTION_RESP_HEAD, head),
    encode(COLLECTION_RESP_BODY, body),
  );
}

function item(cid: string, modifyTime: bigint): Record<string, unknown> {
  return { cid, type: 0, status: 0, modifyTime };
}

test('收藏分页：游标按最小 modifyTime 前进，到底后吃掉游标', async () => {
  const first = await getCollectionPage({
    uin: '10001',
    pskey: 'PSKEY',
    transport: async () =>
      envelope({
        operation: {
          getCollectionList: {
            items: [item('c1', 102n), item('c2', 101n)],
            totalCount: 42,
            reachedBottom: 0,
          },
        },
      }),
  });

  assert.equal(first.hasMore, true);
  assert.deepEqual(first.nextCursor, { timeStamp: '101', sequence: 2 });
  assert.equal(first.totalCount, 42);
  assert.deepEqual(
    first.items.map((entry) => entry.cid),
    ['c1', 'c2'],
  );
  assert.ok(first.rawResponse.length > 0);

  // 真机最后一页回 215000（「还剩 20 条」），同样算到底。
  const last = await getCollectionPage({
    uin: '10001',
    pskey: 'PSKEY',
    cursor: first.nextCursor,
    transport: async () =>
      envelope({
        operation: { getCollectionList: { items: [item('c3', 100n)], reachedBottom: 215_000 } },
      }),
  });

  assert.equal(last.hasMore, false);
  assert.equal(last.nextCursor, null);
  assert.equal(last.totalCount, null);
});

test('收藏分页：非法到底标记 / 游标不前进都拒绝', async () => {
  const unknownBottom = {
    uin: '10001',
    pskey: 'PSKEY',
    transport: async () =>
      envelope({ operation: { getCollectionList: { items: [], reachedBottom: 7 } } }),
  };
  await assert.rejects(getCollectionPage(unknownBottom), /invalid reachedBottom/);
  await assert.rejects(getCollectionList(unknownBottom), /invalid reachedBottom/);

  // 报了还有更多，却给出不比请求游标更旧的时间戳 → 继续拉就是死循环。
  await assert.rejects(
    getCollectionPage({
      uin: '10001',
      pskey: 'PSKEY',
      cursor: { timeStamp: '100', sequence: 2 },
      transport: async () =>
        envelope({
          operation: { getCollectionList: { items: [item('c1', 100n)], reachedBottom: 0 } },
        }),
    }),
    /made no progress/,
  );
});

test('收藏全文：按入参顺序对应，SILK / 图片 / 文件原样交出', async () => {
  const details = await getCollectionDetails({
    uin: '10001',
    pskey: 'PSKEY',
    cids: ['c1', 'c2'],
    transport: async () =>
      envelope({
        operation: {
          getCollectionContent: {
            contents: [
              { textContent: { data: 'hi', hasEmoji: true } },
              {
                audioContent: { data: new Uint8Array([1, 2, 3]) },
                richMediaContent: {
                  picList: [{ url: 'https://p/q', width: 3, height: 4, size: 5 }],
                  fileList: [{ fid: 'f1', name: 'a.txt', size: 7n }],
                },
              },
            ],
          },
        },
      }),
  });

  assert.deepEqual(
    details.map((entry) => entry.cid),
    ['c1', 'c2'],
  );
  assert.deepEqual(details[0]?.content.textContent, { data: 'hi', hasEmoji: true });
  assert.equal(details[0]?.content.audioContent, null);
  assert.deepEqual([...(details[1]?.content.audioContent?.data ?? [])], [1, 2, 3]);
  const rich = details[1]?.content.richMediaContent;
  assert.equal(rich?.picList[0]?.width, 3);
  assert.deepEqual(rich?.picList[0]?.md5, null);
  assert.equal(rich?.fileList[0]?.size, 7n);
  assert.equal(rich?.fileList[0]?.fid, 'f1');
});

test('收藏全文：数量不匹配 / 重复 cid / 超批量都拒收', async () => {
  await assert.rejects(
    getCollectionDetails({
      uin: '10001',
      pskey: 'PSKEY',
      cids: ['c1', 'c2'],
      transport: async () =>
        envelope({
          operation: { getCollectionContent: { contents: [{ textContent: { data: 'x' } }] } },
        }),
    }),
    /count mismatch/,
  );

  await assert.rejects(
    getCollectionDetails({
      uin: '10001',
      pskey: 'PSKEY',
      cids: ['c1', 'c1'],
      transport: async () => envelope({}),
    }),
    /duplicate ids/,
  );

  await assert.rejects(
    getCollectionDetails({
      uin: '10001',
      pskey: 'PSKEY',
      cids: Array.from({ length: 21 }, (_, index) => `c${index}`),
      transport: async () => envelope({}),
    }),
    /1-20 ids/,
  );
});

const FILE = {
  src: 1,
  uid: 0n,
  bid: 2,
  fid: 'fid-1',
  name: 'a b.txt',
  size: 10n,
  md5: new Uint8Array(16),
  sha1: new Uint8Array(20),
  category: 0,
  ntUid: '',
};

function downloadResponse(
  apply: Record<string, unknown>,
  headerTail = new Uint8Array(),
): Uint8Array {
  return encodeCollectionEnvelope(
    Buffer.concat([
      encode(COLLECTION_DOWNLOAD_RESP_HEAD, {
        uin: 10001n,
        sequence: 1,
        command: 2,
        operation: 20_014,
      }),
      headerTail,
    ]),
    encode(COLLECTION_DOWNLOAD_RESP_BODY, { operation: { apply } }),
  );
}

test('收藏附件下载：请求头用自己的版本，响应拼出一一次性地址', async () => {
  let bodySeen: Uint8Array | undefined;
  const resource = await applyCollectionFileDownload({
    uin: '10001',
    pskey: 'PSKEY',
    cid: 'c1',
    clientBuild: '7.0.2-53644',
    file: FILE,
    transport: async (request) => {
      bodySeen = request.body;
      return downloadResponse({
        key: new Uint8Array([0xab, 0xcd]),
        httpsHost: 'ftn.qq.com',
        httpsPort: 443,
        cookieName: 'skey',
        cookieValue: 'v1',
        route: { type: 1 },
      });
    },
  });

  assert.ok(bodySeen);
  // 信封偏移 10 处是 **body** 长度，头紧跟在 16 字节固定头后面。
  const bytes = Buffer.from(bodySeen);
  const split = bytes.length - bytes.readUInt32BE(10);
  const head = decode(COLLECTION_DOWNLOAD_REQ_HEAD, bodySeen.subarray(16, split));
  assert.equal(head.operation, 20_014);
  assert.equal(head.version, 0x5f5e1642);
  assert.equal(head.client, 0x610);
  assert.equal(head.ticket, 'PSKEY');
  // file 描述符必须真的写进请求：留成空描述符服务端只会回「文件不存在」。
  assert.ok(bytes.subarray(split).includes(Buffer.from('fid-1')));

  assert.equal(resource.url, 'https://ftn.qq.com/ftn_handler/abcd/?fname=a%20b.txt');
  assert.equal(resource.cookie, 'skey=v1');
});

test('收藏附件下载：只接受完整头部字段之后的零填充', async () => {
  const apply = {
    key: new Uint8Array([0xab, 0xcd]),
    httpsHost: 'ftn.qq.com',
    httpsPort: 443,
    cookieName: 'skey',
    cookieValue: 'v1',
    route: { type: 1 },
  };
  const params = {
    uin: '10001',
    pskey: 'PSKEY',
    cid: 'c1',
    clientBuild: '7.0.2-53644',
    file: FILE,
  };
  const result = await applyCollectionFileDownload({
    ...params,
    transport: async () => downloadResponse(apply, Uint8Array.of(0)),
  });
  assert.equal(result.url, 'https://ftn.qq.com/ftn_handler/abcd/?fname=a%20b.txt');
  for (const tail of [Uint8Array.of(0x2a, 0x05, 0x61), Uint8Array.of(0, 0, 1)]) {
    await assert.rejects(
      applyCollectionFileDownload({
        ...params,
        transport: async () => downloadResponse(apply, tail),
      }),
      /返回无效响应/,
    );
  }
});

test('收藏附件下载：无效构建标识 / 服务端错误 / 非 QQ 域都拒收', async () => {
  await assert.rejects(
    applyCollectionFileDownload({
      uin: '10001',
      pskey: 'PSKEY',
      cid: 'c1',
      clientBuild: 'unknown',
      file: FILE,
      transport: async () => downloadResponse({}),
    }),
    /无法识别当前 QQ 构建/,
  );

  await assert.rejects(
    applyCollectionFileDownload({
      uin: '10001',
      pskey: 'PSKEY',
      cid: 'c1',
      clientBuild: '7.0.1-52892',
      file: FILE,
      transport: async () =>
        encodeCollectionEnvelope(
          encode(COLLECTION_DOWNLOAD_RESP_HEAD, {
            uin: 10001n,
            sequence: 1,
            command: 2,
            operation: 20_014,
            retCode: 215_000,
            retMsg: 'collect 不存在',
          }),
          encode(COLLECTION_DOWNLOAD_RESP_BODY, { operation: { apply: {} } }),
        ),
    }),
    /215000.*collect 不存在/,
  );

  await assert.rejects(
    applyCollectionFileDownload({
      uin: '10001',
      pskey: 'PSKEY',
      cid: 'c1',
      clientBuild: '7.0.1-52892',
      file: FILE,
      transport: async () =>
        downloadResponse({
          key: new Uint8Array([1]),
          httpsHost: 'evil.example',
          httpsPort: 443,
          cookieName: 'k',
          cookieValue: 'v',
          route: { type: 1 },
        }),
    }),
    /下载地址不受支持/,
  );

  await assert.rejects(
    applyCollectionFileDownload({
      uin: '10001',
      pskey: 'PSKEY',
      cid: 'c1',
      clientBuild: '7.0.1-52892',
      file: FILE,
      transport: async () =>
        downloadResponse({
          key: new Uint8Array([1]),
          httpsHost: 'ftn.qq.com',
          httpsPort: 443,
          cookieName: 'k',
          cookieValue: 'v',
          route: { type: 2 },
        }),
    }),
    /暂未返回可用的安全下载地址/,
  );
});
