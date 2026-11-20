/** 群权限（0x88d_0）解码与「缺字段不等于许可」（离线）。 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GetGroupOperationInfo as Query } from '../src/oidb/group-admin/get-group-operation-info';
import { decode, encode } from '../src/protobuf';

/** 记录 sendOidbPacket 的实际参数；回包按 subCommand 选择。 */
function fakeOidb(reply: (subCommand: number) => Uint8Array) {
  const calls: Array<{ sessionId: number; command: number; subCommand: number }> = [];
  return {
    calls,
    nt: {
      sendOidbPacket: async (sessionId: number, command: number, subCommand: number) => {
        calls.push({ sessionId, command, subCommand });
        return reply(subCommand);
      },
    },
  };
}

test('用 0x88d_0 读取权限，110 的成功但缺字段回包不算未禁言', async () => {
  // 同群线上对照回包，仅将群号替换为 123；110 不返回全员禁言，0 返回非零值。
  const limited = Buffer.from(
    '0a1d087b10001a17200030f909f00200e80400f80400b00500980600e00604',
    'hex',
  );
  const complete = Buffer.from(
    '0a2a087b10001a2430f909e802c4b4e5d70ef00200c003c081a420f80400b00500c00500e00604ea06020804',
    'hex',
  );
  const { calls, nt } = fakeOidb((subCommand) => (subCommand === 0 ? complete : limited));

  assert.deepEqual(
    (({ muteAll, muteUntil }) => ({ muteAll, muteUntil }))(
      Query.deserialize(decode(Query.respSchema, limited))[0]!,
    ),
    { muteAll: null, muteUntil: 0 },
  );

  const row = await Query.invoke(nt, 9, { groupId: 123 });
  assert.equal(row.muteAll, true);
  assert.equal(row.muteUntil, 0);
  assert.equal(row.memberCanUpload, true);
  assert.deepEqual(calls, [{ sessionId: 9, command: 0x88d, subCommand: 0 }]);
});

test('按独立 Android FieldMap 样本解码，缺失不补成许可', () => {
  // group 123，info: privilegeFlag@56=2, rename@88=2, kick@86=1, ext@109.14=2。
  const raw = Buffer.from('0a12087b1a0ec00302c00502b00501ea06027002', 'hex');
  const row = Query.deserialize(decode(Query.respSchema, raw))[0]!;
  assert.equal(row.memberCanUpload, false);
  assert.equal(row.memberCanRename, true);
  assert.equal(row.allowMemberKick, true);
  assert.equal(row.memberCanEssence, true);
  assert.equal(row.muteAll, null);
  assert.equal(row.muteUntil, null);
});

test('返回了群但没返回字段时保留未知', () => {
  const [row] = Query.deserialize({ groups: [{ groupCode: 123n, info: {} }] });
  assert.equal(row?.memberCanRename, null);
  assert.equal(row?.memberCanEssence, null);
  assert.equal(row?.allowMemberKick, null);
  assert.equal(row?.memberCanUpload, null);
});

test('拒绝业务错误与错误数字字段', () => {
  assert.throws(() => Query.deserialize({ groups: [{ result: 5 }] }));
  assert.throws(() => Query.deserialize({ groups: [{ info: { muteUntil: -1 } }] }));
});

test('请求只选择已确认字段，零值选择器保留', () => {
  const parsed = decode(
    Query.reqSchema,
    encode(Query.reqSchema, Query.serialize({ groupId: 123 })),
  );
  assert.deepEqual(parsed.groups, [
    {
      groupCode: 123n,
      info: {
        muteAllUntil: 0n,
        muteUntil: 0,
        privilegeFlag: 0,
        isConf: 0,
        allowMemberKick: 0,
        memberRenameSwitch: 0,
        extension: { essencePrivilege: 0 },
      },
    },
  ]);
});

test('永久全员禁言的 uint64 最大值不会丢掉其他权限', () => {
  const [row] = Query.deserialize({
    groups: [
      { groupCode: 123n, info: { muteAllUntil: 0xffffffffffffffffn, memberRenameSwitch: 2 } },
    ],
  });
  assert.equal(row?.muteAll, true);
  assert.equal(row?.memberCanRename, true);
  assert.throws(() => Query.deserialize({ groups: [{ info: { muteAllUntil: -1n } }] }));
});

test('无效群号不能发出权限请求', () => {
  for (const groupId of [0, -1, 1.5, Number.NaN]) assert.throws(() => Query.serialize({ groupId }));
});

test('管理员权限解析收到原请求，拒绝错群或错成员', async () => {
  const { GetAdminPermissions } = await import('../src/oidb/group-admin/admin-permissions');
  const { nt } = fakeOidb(() =>
    encode(GetAdminPermissions.respSchema, {
      groupCode: 123n,
      members: [{ memberUin: 10001n, ext: { permissions: { items: [{ item: 2, value: 2 }] } } }],
    }),
  );
  const permission = await GetAdminPermissions.invoke(nt, 9, { groupId: 123, userId: 10001 });
  assert.equal(permission.recallMemberMessage, false);
  assert.equal(permission.kickMember, null);
  await assert.rejects(
    () => GetAdminPermissions.invoke(nt, 9, { groupId: 456, userId: 10001 }),
    /群号/,
  );
  await assert.rejects(
    () => GetAdminPermissions.invoke(nt, 9, { groupId: 123, userId: 10002 }),
    /匹配成员/,
  );
});
