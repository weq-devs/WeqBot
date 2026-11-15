/**
 * `set_group_add_request` 的 backend。
 *
 * 这条 action 之前只注册不实装（后端没有 `setGroupAddRequest`，永远 1404）。
 * 这里的契约是：
 *   - 三种 flag 形态都能落到正确的 `(groupId, sequence, eventType, filtered)`；
 *   - `eventType` **原样回填** 0x10C0 的 field 2（不过 `groupRequestOperationType`
 *     —— 那会把入群申请的 1 翻成 2，把「同意入群」发成「邀请」）；
 *   - 匹配不到 / 多条匹配都明确报错，不猜着发；
 *   - `operateTransInfo` 有就带上。
 *
 * 用假 `ProtocolClient`：只验发哪条命令、带什么字段。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { decode, encode, message, type ProtoMessage } from '@weqbot/protocol';
import { createProtocolBackend } from '../src/onebot-backend';

const SELF_UIN = '10001';
const GROUP = 987654;

interface Inbox {
  main: Record<string, unknown>[];
  filtered: Record<string, unknown>[];
}

interface SentOidb {
  command: number;
  subCommand: number;
  body: Record<string, unknown>;
}

/** 0x10C0 回包字段（UIN 形态 + UID 混合解码）。 */
function requestRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sequence: 123,
    eventType: 1,
    state: 1,
    group: { groupUin: GROUP, groupName: '群' },
    target: { uin: 10002, uid: 'u_guest', name: '申请人' },
    invitor: { uin: 0, uid: '', name: '' },
    operatorUser: { uin: 0, uid: '', name: '' },
    comment: '求进群',
    ...overrides,
  };
}

/**
 * 0x10C0 的回包走 `decodeResponseBody`（同一份字节按 UIN / UID 两种 schema 各解
 * 一遍再合并）。这里按真机形状编码：per-user 记录的 field 1 是 uid 字符串。
 */
function inboxBytes(rows: Record<string, unknown>[]): Uint8Array {
  // schema 定义在 group-requests.ts 内部；用 `message()` 重建一份等价形状。
  //
  // ⚠️ 真机上 field 1 承载的是 **uid 字符串**（UIN 形态只在信封层，per-user 记录
  // 仍是字符串账号）。协议层的解码器就是从同一份字节按两种 schema 各解一遍再合并，
  // 所以这里照真机编码成 UID 形态。
  const USER_UID = message([
    { name: 'uid', tag: 1, type: 'string' },
    { name: 'name', tag: 2, type: 'string' },
  ]);
  const GROUP_SCHEMA = message([
    { name: 'groupUin', tag: 1, type: 'uint32' },
    { name: 'groupName', tag: 2, type: 'string' },
  ]);
  const ENTRY = message([
    { name: 'sequence', tag: 1, type: 'uint64' },
    { name: 'eventType', tag: 2, type: 'uint32' },
    { name: 'state', tag: 3, type: 'uint32' },
    { name: 'group', tag: 4, type: GROUP_SCHEMA },
    { name: 'target', tag: 5, type: USER_UID },
    { name: 'invitor', tag: 6, type: USER_UID },
    { name: 'operatorUser', tag: 7, type: USER_UID },
    { name: 'comment', tag: 10, type: 'string' },
  ]);
  const RESP = message([
    { name: 'requests', tag: 1, type: ENTRY, repeated: true },
    { name: 'cookie', tag: 2, type: 'uint64' },
  ]);
  return encode(RESP, { requests: rows, cookie: 0 });
}

interface Harness {
  backend: ReturnType<typeof createProtocolBackend>;
  sent: SentOidb[];
}

function makeBackend(inbox: Inbox): Harness {
  const sent: SentOidb[] = [];
  const protocol = {
    native: {
      sendOidbPacket: async (
        _sessionId: number,
        command: number,
        subCommand: number,
        body: Uint8Array,
      ) => {
        // 0x10C0 回对应的收件箱；0x10C8 记下请求体（用一份等价 schema 解出来）。
        if (command === 0x10c0) {
          return inboxBytes(subCommand === 2 ? inbox.filtered : inbox.main);
        }
        const request = decode(messageSchema(), body) as Record<string, unknown>;
        sent.push({ command, subCommand, body: request });
        return new Uint8Array();
      },
    },
    sessionId: 7,
  } as never;
  return { backend: createProtocolBackend({ protocol, selfUin: SELF_UIN }), sent };
}

/** 0x10C8 请求体的等价 schema（accept tag1 + body{sequence,eventType,groupUin,message,operateTransInfo}）。 */
function messageSchema(): ProtoMessage {
  const BODY = message([
    { name: 'sequence', tag: 1, type: 'uint64' },
    { name: 'eventType', tag: 2, type: 'uint32' },
    { name: 'groupUin', tag: 3, type: 'uint32' },
    { name: 'message', tag: 4, type: 'string' },
    { name: 'operateTransInfo', tag: 7, type: 'bytes' },
  ]);
  return message([
    { name: 'accept', tag: 1, type: 'uint32' },
    { name: 'body', tag: 2, type: BODY },
  ]);
}

test('slreq 规范形态：直接发四元组，eventType 原样', async () => {
  const { backend, sent } = makeBackend({ main: [requestRow()], filtered: [] });
  await backend.setGroupAddRequest!('slreq:1:123:987654:1:0', true, '');
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.command, 0x10c8);
  assert.equal(sent[0]!.subCommand, 1);
  const body = sent[0]!.body.body as Record<string, unknown>;
  assert.equal(sent[0]!.body.accept, 1);
  assert.equal(body.sequence, 123n);
  assert.equal(body.eventType, 1);
  assert.equal(body.groupUin, GROUP);
  // 空理由上 wire 是空格（协议层约定）。
  assert.equal(body.message, ' ');
});

test('推送形态 add:群号:uid → 反查收件箱，且 eventType 不被映射成 2', async () => {
  const { backend, sent } = makeBackend({ main: [requestRow()], filtered: [] });
  await backend.setGroupAddRequest!(`add:${GROUP}:u_guest`, true, '欢迎');
  assert.equal(sent.length, 1);
  const body = sent[0]!.body.body as Record<string, unknown>;
  assert.equal(body.eventType, 1, '入群申请的 wire 类型必须原样回填');
  assert.equal(body.message, '欢迎');
});

test('裸序号 → 反查', async () => {
  const { backend, sent } = makeBackend({ main: [requestRow()], filtered: [] });
  await backend.setGroupAddRequest!('123', false, '满了');
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.body.accept, 2);
  const body = sent[0]!.body.body as Record<string, unknown>;
  assert.equal(body.eventType, 1);
  assert.equal(body.message, '满了');
});

test('过滤收件箱的请求走 0x10C8_2', async () => {
  const { backend, sent } = makeBackend({
    main: [],
    filtered: [requestRow({ sequence: 456 })],
  });
  await backend.setGroupAddRequest!(`add:${GROUP}:u_guest`, true, '');
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.subCommand, 2);
  assert.equal((sent[0]!.body.body as Record<string, unknown>).sequence, 456n);
});

test('邀请形态看 invitor', async () => {
  const { backend, sent } = makeBackend({
    main: [
      requestRow({
        sequence: 789,
        eventType: 22,
        target: { uin: 0, uid: '', name: '' },
        invitor: { uin: 10003, uid: 'u_host', name: '邀请人' },
      }),
    ],
    filtered: [],
  });
  await backend.setGroupAddRequest!(`invite:${GROUP}:u_host`, true, '');
  assert.equal(sent.length, 1);
  assert.equal((sent[0]!.body.body as Record<string, unknown>).eventType, 22);
});

test('匹配不到 / 多条匹配都报错，不发包', async () => {
  const none = makeBackend({ main: [], filtered: [] });
  await assert.rejects(
    none.backend.setGroupAddRequest!(`add:${GROUP}:u_guest`, true, ''),
    /没有匹配/,
  );
  assert.equal(none.sent.length, 0);

  const multi = makeBackend({
    main: [requestRow({ sequence: 1 }), requestRow({ sequence: 2 })],
    filtered: [],
  });
  await assert.rejects(
    multi.backend.setGroupAddRequest!(`add:${GROUP}:u_guest`, true, ''),
    /多条待处理请求/,
  );
  assert.equal(multi.sent.length, 0);
});

test('非法 flag 直接抛，不发包', async () => {
  const { backend, sent } = makeBackend({ main: [requestRow()], filtered: [] });
  await assert.rejects(backend.setGroupAddRequest!('remove:1:u_x', true, ''), /不支持/);
  assert.equal(sent.length, 0);
});
