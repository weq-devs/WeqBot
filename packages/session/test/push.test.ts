import assert from 'node:assert/strict';
import test from 'node:test';
import {
  encode,
  INPUT_STATUS_NOTIFY,
  message,
  MSG_PUSH_CMD,
  MSG_PUSH_ENVELOPE,
} from '@weqbot/protocol';
import { PushBridge } from '../src/push';

function frame(body: Uint8Array) {
  return { sessionId: 1, command: MSG_PUSH_CMD, body, seq: 1, ts: Date.now() };
}

function groupMessage(text: string, bubble: number): Record<string, unknown> {
  return {
    responseHead: {
      fromUin: 10001,
      fromUid: 'u_sender',
      grp: { groupUin: 55555, memberCard: '群名片', groupName: '测试群' },
    },
    contentHead: { msgType: 82, msgId: 42, sequence: 9001, timestamp: 1_700_000_000 },
    body: {
      richText: {
        elems: [{ text: { str: text } }, { bubble: { id: bubble } }],
      },
    },
  };
}

test('聊天消息 → InboundMessage，装扮与 peer 都保留', () => {
  const bridge = new PushBridge({ selfUin: '10002', selfUid: 'u_self' });
  const result = bridge.handle(
    frame(encode(MSG_PUSH_ENVELOPE, { messages: [groupMessage('hi', 9)] })),
  );

  assert.equal(result.events.length, 1);
  const event = result.events[0];
  assert.ok(event && event.type === 'message');
  assert.equal(event.message.scene, 'group');
  assert.equal(event.message.peer.id, '55555');
  assert.equal(event.message.peer.name, '测试群');
  assert.equal(event.message.sender.id, '10001');
  assert.equal(event.message.sender.name, '群名片');
  assert.deepEqual(event.message.dress, { bubble: 9, font: 0, widget: 0 });
  assert.deepEqual(event.message.elements, [{ kind: 'text', textContent: 'hi' }]);
  // contentHead.msgId 要透出成 `random`：私聊撤回靠它定位原消息。
  assert.equal(event.message.random, 42);
  assert.equal(bridge.resolveUin('u_sender'), '10001');
});

test('输入状态在观测到 uid→uin 后补全 peer', () => {
  const bridge = new PushBridge({ selfUin: '10002' });
  const message = encode(MSG_PUSH_ENVELOPE, { messages: [groupMessage('hi', 0)] });
  bridge.handle(frame(message));

  const content = encode(INPUT_STATUS_NOTIFY, {
    fromUid: 'u_sender',
    toUid: 'u_self',
    notifyItem: { eventType: 1 },
  });
  const result = bridge.handle(
    frame(
      encode(MSG_PUSH_ENVELOPE, {
        messages: [
          {
            responseHead: { fromUin: 10001, fromUid: 'u_sender' },
            contentHead: { msgType: 528, subType: 277, timestamp: 1_700_000_100 },
            body: { msgContent: content },
          },
        ],
      }),
    ),
  );

  const event = result.events[0];
  assert.ok(event && event.type === 'notice' && event.kind === 'input-status');
  assert.equal(event.peer.id, '10001');
  assert.equal(event.text, '对方正在输入...');
});

const GROUP_CHANGE = message([
  { name: 'groupUin', tag: 1, type: 'uint32' },
  { name: 'flag', tag: 2, type: 'uint32' },
  { name: 'memberUid', tag: 3, type: 'string' },
  { name: 'decreaseType', tag: 4, type: 'uint32' },
  { name: 'operatorBytes', tag: 5, type: 'bytes' },
]);

test('33 入群 → group-member-increase，uid 用观测缓存补 uin', () => {
  const bridge = new PushBridge({ selfUin: '10002', selfUid: 'u_self' });
  bridge.handle(frame(encode(MSG_PUSH_ENVELOPE, { messages: [groupMessage('hi', 0)] })));

  const result = bridge.handle(
    frame(
      encode(MSG_PUSH_ENVELOPE, {
        messages: [
          {
            responseHead: { fromUin: 55555, fromUid: 'u_group', grp: { groupUin: 55555 } },
            contentHead: {
              msgType: 33,
              subType: 0,
              msgId: 1,
              sequence: 2,
              timestamp: 1_700_000_200,
            },
            body: {
              msgContent: encode(GROUP_CHANGE, {
                groupUin: 55555,
                memberUid: 'u_sender',
                decreaseType: 3,
                operatorBytes: new TextEncoder().encode('u_op'),
              }),
            },
          },
        ],
      }),
    ),
  );

  const event = result.events[0];
  assert.ok(event && event.type === 'notice');
  assert.equal(event.kind, 'group-member-increase');
  if (event.kind !== 'group-member-increase') return;
  assert.equal(event.group.id, '55555');
  assert.equal(event.member.id, '10001');
  assert.equal(event.operator?.id, 'u_op');
});

test('好友申请 → request / friend，事件总线可收到 request', () => {
  const bridge = new PushBridge({ selfUin: '10002', selfUid: 'u_self' });
  const content = encode(
    message([
      {
        name: 'info',
        tag: 1,
        type: message([
          { name: 'sourceUid', tag: 2, type: 'string' },
          { name: 'message', tag: 10, type: 'string' },
        ]),
      },
    ]),
    { info: { sourceUid: 'u_req', message: '加个好友' } },
  );
  const result = bridge.handle(
    frame(
      encode(MSG_PUSH_ENVELOPE, {
        messages: [
          {
            responseHead: { fromUin: 0, fromUid: 'u_req' },
            contentHead: { msgType: 528, subType: 35, timestamp: 1_700_000_300 },
            body: { msgContent: content },
          },
        ],
      }),
    ),
  );
  const event = result.events[0];
  assert.ok(event && event.type === 'request');
  assert.equal(event.kind, 'friend');
  assert.equal(event.from.uid, 'u_req');
  assert.equal(event.comment, '加个好友');
  assert.equal(event.flag, 'u_req');
});

test('未建模的推送进入 unhandled，不丢帧', () => {
  const bridge = new PushBridge({ selfUin: '10002' });
  const result = bridge.handle(
    frame(
      encode(MSG_PUSH_ENVELOPE, {
        messages: [
          {
            responseHead: { fromUin: 1, grp: { groupUin: 2 } },
            contentHead: { msgType: 44, subType: 1, timestamp: 1 },
            body: { msgContent: new Uint8Array([1]) },
          },
        ],
      }),
    ),
  );
  assert.equal(result.events.length, 0);
  assert.equal(result.unhandled.length, 1);
  assert.equal(result.unhandled[0]?.kind, 'system');
});
