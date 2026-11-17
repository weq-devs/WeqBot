/** 共同资料（0xcf4）读取：只保留服务端原名，不自行推断（离线）。 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LegacyOidbRejectedError, legacyOidbEnvelope } from '../src/oidb/legacy';
import { getProfileSimilarity } from '../src/oidb/profile/similarity';
import { decode, encode, message } from '../src/protobuf';

const identity = Buffer.from('08914e10924e', 'hex');
const wording = message([{ name: 'text', tag: 3, type: 'bytes' }]);
const records = message([{ name: 'items', tag: 14, type: wording, repeated: true }]);

function body(texts: string[]): Buffer {
  return Buffer.concat([
    identity,
    encode(records, { items: texts.map((text) => ({ text: Buffer.from(text) })) }) as Buffer,
  ]);
}

/** 记录 sendPacket 调用，回一个构造好的旧 OIDB 信封。 */
function binding(bytes: Uint8Array, result = 0, command = 0xcf4) {
  const calls: Array<[number, string, Uint8Array]> = [];
  return {
    calls,
    nt: {
      sendPacket: async (sessionId: number, cmd: string, payload: Uint8Array) => {
        calls.push([sessionId, cmd, payload]);
        return Buffer.from(
          encode(legacyOidbEnvelope, { command, serviceType: 0, result, body: bytes }),
        );
      },
    },
  };
}

test('首个且唯一请求是 0xcf4，手写 wire 正对照保留服务器原文', async () => {
  const { calls, nt } = binding(Buffer.from('08914e10924e720b1a0973616d652063697479', 'hex'));
  assert.deepEqual(await getProfileSimilarity(nt, 7, '10001', '10002'), {
    targetUin: '10002',
    source: 'dna',
    items: [{ icon: null, title: '', wordings: ['same city'] }],
  });
  assert.equal(calls.length, 1);
  const [sessionId, cmd, payload] = calls[0]!;
  assert.equal(sessionId, 7);
  assert.equal(cmd, 'OidbSvc.0xcf4');
  const request = decode(legacyOidbEnvelope, payload);
  assert.equal(request.command, 0xcf4);
  assert.equal(request.serviceType, 0);
  assert.equal(Buffer.from(request.body as Uint8Array).toString('hex'), '08914e10924e20013000');
});

test('只去重相同非空文案，不改写也不引入新 DNA 小结', async () => {
  const text = '我在甲地，好友在乙地';
  const { nt } = binding(
    Buffer.concat([body([text, ' ', text, ' 原文保留 ']), Buffer.from('aa0100', 'hex')]),
  );
  assert.deepEqual((await getProfileSimilarity(nt, 7, '10001', '10002')).items, [
    { icon: null, title: '', wordings: [text, ' 原文保留 '] },
  ]);
});

test('双方身份有效的成功空响应与全空白文案返回空列表', async () => {
  for (const bytes of [identity, body(['', ' '])])
    assert.deepEqual(await getProfileSimilarity(binding(bytes).nt, 7, '10001', '10002'), {
      targetUin: '10002',
      source: 'dna',
      items: [],
    });
});

test('双方身份错误或缺失时拒绝，不转向聚合', async () => {
  for (const hex of ['08934e10924e', '08914e10934e', '08914e', '10924e', '']) {
    const { calls, nt } = binding(Buffer.from(hex, 'hex'));
    await assert.rejects(getProfileSimilarity(nt, 7, '10001', '10002'), /匹配/);
    assert.equal(calls.length, 1);
  }
});

test('业务拒绝保留实际结果且不发送第二个请求', async () => {
  for (const result of [1, 151, 316]) {
    const { calls, nt } = binding(Buffer.alloc(0), result);
    await assert.rejects(getProfileSimilarity(nt, 7, '10001', '10002'), (error: Error) => {
      assert.ok(error instanceof LegacyOidbRejectedError);
      assert.equal((error as LegacyOidbRejectedError).result, result);
      return true;
    });
    assert.equal(calls.length, 1);
  }
});

test('传输失败直接返回，不调用任何其他业务', async () => {
  const failure = new Error('合成传输失败');
  const nt = {
    sendPacket: async () => {
      throw failure;
    },
  };
  await assert.rejects(
    getProfileSimilarity(nt, 7, '10001', '10002'),
    (error: Error) => error === failure,
  );
});

test('拒绝错命令、截断和损坏 UTF-8，不降级为空', async () => {
  for (const { nt } of [
    binding(identity, 0, 0xcf5),
    binding(Buffer.concat([identity, Buffer.from('72031a02ff', 'hex')])),
    binding(Buffer.from('08914e10924e72031a01ff', 'hex')),
  ])
    await assert.rejects(getProfileSimilarity(nt, 7, '10001', '10002'));
});

test('限制条目数量与单条文案长度，边界值仍可读取', async () => {
  for (const bytes of [body(Array(101).fill('a')), body(['a'.repeat(65537)])])
    await assert.rejects(getProfileSimilarity(binding(bytes).nt, 7, '10001', '10002'), /无效/);
  const text = 'a'.repeat(65536);
  const items = (await getProfileSimilarity(binding(body([text])).nt, 7, '10001', '10002')).items;
  assert.deepEqual(items[0]?.wordings, [text]);
});

test('无效目标在发包前拒绝', async () => {
  for (const [self, target] of [
    ['10001', '10001'],
    ['bad', '10002'],
    ['10001', 'bad'],
  ]) {
    const { calls, nt } = binding(identity);
    await assert.rejects(getProfileSimilarity(nt, 7, self!, target!));
    assert.equal(calls.length, 0);
  }
});
