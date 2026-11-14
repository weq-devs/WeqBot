/**
 * 陌生人资料（OIDB 0xFE1_2）的请求 / 响应形状。
 *
 * 离线用例：用 `encode` 造一份真实形状的响应，再走生产用的 `deserializeProfile`。
 * 验的是「属性 key → 字段」的映射和几个边界（uin 回显缺失、账号不匹配）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decode, encode } from '../src/protobuf';
import {
  deserializeProfile,
  FetchUserProfile,
  PROFILE_KEY,
  readProperties,
} from '../src/oidb/profile/get-user-qq-level';

function response(options: {
  uin?: number;
  uid?: string;
  numbers?: Array<[number, number]>;
  bytes?: Array<[number, Uint8Array]>;
}): Record<string, unknown> {
  return {
    body: {
      ...(options.uid !== undefined ? { uid: options.uid } : {}),
      ...(options.uin !== undefined ? { uin: options.uin } : {}),
      properties: {
        numberProperties: (options.numbers ?? []).map(([key, value]) => ({
          number1: key,
          number2: value,
        })),
        bytesProperties: (options.bytes ?? []).map(([code, value]) => ({ code, value })),
      },
    },
  };
}

/** 走一遍真实的编码 → 解码，确保 schema 与字段名真的对得上。 */
function roundTrip(body: Record<string, unknown>): Record<string, unknown> {
  return decode(FetchUserProfile.respSchema, encode(FetchUserProfile.respSchema, body)) as Record<
    string,
    unknown
  >;
}

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

test('请求只带需要的 key，uin 必须是正整数', () => {
  const request = FetchUserProfile.serialize({ uin: 2863253201 });
  assert.equal(request.uin, 2863253201);
  const keys = (request.keys as Array<{ key: number }>).map((entry) => entry.key);
  assert.ok(keys.includes(PROFILE_KEY.nickname), '昵称是必需项');
  assert.ok(keys.includes(PROFILE_KEY.gender));
  assert.ok(keys.includes(PROFILE_KEY.age));
  // 同一条命令也查 QQ 等级，但 `get_stranger_info` 不需要头像这种大字段。
  assert.ok(!keys.includes(PROFILE_KEY.avatar), '不该顺手拉头像 proto');
  assert.equal(new Set(keys).size, keys.length, 'key 不能重复');

  assert.throws(() => FetchUserProfile.serialize({ uin: 0 }), /uin/);
});

test('昵称 / 性别 / 年龄 / 签名按 key 解出来', () => {
  const info = deserializeProfile(
    roundTrip(
      response({
        uin: 2863253201,
        uid: 'u_target',
        numbers: [
          [PROFILE_KEY.gender, 1],
          [PROFILE_KEY.age, 25],
          [PROFILE_KEY.level, 64],
        ],
        bytes: [
          [PROFILE_KEY.nickname, text('小明')],
          [PROFILE_KEY.sign, text('在写 bot')],
        ],
      }),
    ),
    2863253201,
  );

  assert.deepEqual(info, {
    uin: 2863253201,
    uid: 'u_target',
    nickname: '小明',
    remark: '',
    qid: '',
    sign: '在写 bot',
    sex: 'male',
    age: 25,
    level: 64,
  });
});

test('性别 2 → female，其它值 → unknown', () => {
  assert.equal(
    deserializeProfile(roundTrip(response({ uin: 1, numbers: [[PROFILE_KEY.gender, 2]] })), 1).sex,
    'female',
  );
  assert.equal(
    deserializeProfile(roundTrip(response({ uin: 1, numbers: [[PROFILE_KEY.gender, 255]] })), 1)
      .sex,
    'unknown',
  );
});

test('服务端省略 uin 回显时用请求的 uin 兜底', () => {
  const info = deserializeProfile(roundTrip(response({ uid: 'u_x' })), 123456);
  assert.equal(info.uin, 123456);
});

test('回显的 uin 与请求不一致时直接报错，不返回错人的资料', () => {
  assert.throws(() => deserializeProfile(roundTrip(response({ uin: 999 })), 123456), /不匹配/);
});

test('响应没有 body 时报错', () => {
  assert.throws(() => deserializeProfile({}, 1), /body/);
});

test('readProperties 兼容 repeated 字段缺失与空表', () => {
  assert.equal(readProperties({ body: {} }).numbers.size, 0);
  assert.equal(readProperties({ body: { properties: {} } }).bytes.size, 0);
});
