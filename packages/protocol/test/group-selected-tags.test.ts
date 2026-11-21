import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GetGroupSelectedTags as Read,
  SetGroupSelectedTags as Write,
} from '../src/oidb/group-admin/group-selected-tags';
import { encode } from '../src/protobuf';

test('读官方群资料的 tag 41 标签记录，缺字段与明确为空分别保留', () => {
  const read = (hex: string, groupId = 123) =>
    Read.deserialize(Read.decodeResponseBody(Buffer.from(hex, 'hex')), { groupId });
  const tagged = '0a10087b10001a0aca0207107b42036f6c64';
  assert.deepEqual(read(tagged), ['old']);
  assert.deepEqual(read('0a09087b10001a03c20200'), []);
  assert.deepEqual(read('0a09087b10001a037a0161'), []);
  assert.equal(read('0a0d087b10001a077a0161c2020178'), null);
  assert.equal(read('0a06087b10001a00'), null);
  assert.throws(() => read(tagged, 456), /目标群/);
  assert.throws(() => read(tagged.replace('07107b', '07107c')), /记录与目标群/);
  assert.throws(() => read(tagged.replace('6f6c64', 'ff6c64')));
});

test('应用仅发群号与 tag 19，清空发送官方空字符串', () => {
  const request = (tags: string[]) =>
    Buffer.from(encode(Write.reqSchema, Write.serialize({ groupId: 123, tags }))).toString('hex');
  assert.equal(request(['new']), '087b12069a01036e6577');
  assert.equal(request([]), '087b12039a0100');
  assert.throws(() => request(['same', 'same']), /重复/);
});
