import assert from 'node:assert/strict';
import test from 'node:test';
import { encode, INPUT_STATUS_NOTIFY, MSG_PUSH_CMD, MSG_PUSH_ENVELOPE } from '@weqbot/protocol';
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
  const bridge = new PushBridge({ selfUin: '2863253201', selfUid: 'u_self' });
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
  assert.equal(bridge.resolveUin('u_sender'), '10001');
});

test('输入状态在观测到 uid→uin 后补全 peer', () => {
  const bridge = new PushBridge({ selfUin: '2863253201' });
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

test('未建模的推送进入 unhandled，不丢帧', () => {
  const bridge = new PushBridge({ selfUin: '2863253201' });
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
