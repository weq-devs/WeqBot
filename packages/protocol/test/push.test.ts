import assert from 'node:assert/strict';
import test from 'node:test';
import type { RawMessageBody } from '../src/msg/decode';
import { encode } from '../src/protobuf';
import {
  decodeMessageBodies,
  decodePushBody,
  decodePushFrame,
  FRIEND_RECALL,
  GROUP_NOTIFY_BODY,
  INPUT_STATUS_NOTIFY,
  MSG_PUSH_CMD,
  MSG_PUSH_ENVELOPE,
} from '../src/push';

function textElem(text: string): Record<string, unknown> {
  return { text: { str: text } };
}

function groupMessage(overrides: {
  text: string;
  bubble?: number;
  widget?: number;
  font?: number;
  msgId?: number;
}): Record<string, unknown> {
  const elems: Record<string, unknown>[] = [textElem(overrides.text)];
  if (overrides.bubble !== undefined) elems.push({ bubble: { id: overrides.bubble } });
  if (overrides.widget !== undefined || overrides.font !== undefined) {
    elems.push({
      generalFlags: {
        ...(overrides.widget !== undefined ? { widgetId: overrides.widget } : {}),
        ...(overrides.font !== undefined ? { font: { fontId1: overrides.font } } : {}),
      },
    });
  }

  return {
    responseHead: {
      fromUin: 10001,
      fromUid: 'u_sender',
      // 名片是 bytes；type 2 = 字面昵称（真实推送里就是这样）。
      grp: {
        groupUin: 55555,
        memberCard: new TextEncoder().encode('群名片'),
        memberCardType: 2,
        groupName: '测试群',
      },
    },
    contentHead: {
      msgType: 82,
      subType: 0,
      msgId: overrides.msgId ?? 42,
      sequence: 9001,
      timestamp: 1_700_000_000,
    },
    body: { richText: { elems } },
  };
}

function envelope(messages: Record<string, unknown>[]): Uint8Array {
  return encode(MSG_PUSH_ENVELOPE, { messages });
}

test('MsgPush 解出群消息、文本与装扮', () => {
  const events = decodePushBody(
    envelope([groupMessage({ text: '你好', bubble: 123, widget: 7, font: 54981 })]),
  );

  assert.equal(events.length, 1);
  const event = events[0];
  assert.ok(event && event.kind === 'message');
  assert.equal(event.scene, 'group');
  assert.equal(event.message.session.uin, 55555);
  assert.equal(event.message.session.name, '测试群');
  assert.equal(event.message.sender.uin, 10001);
  assert.equal(event.message.sender.name, '群名片');
  assert.deepEqual(event.message.dress, { bubble: 123, font: 54981, widget: 7 });
  assert.deepEqual(event.message.elements, [{ kind: 'text', textContent: '你好' }]);
});

test('一帧里多条 message 全部保留（tag 1 repeated）', () => {
  const events = decodePushBody(
    envelope([
      groupMessage({ text: '第一条', msgId: 1 }),
      groupMessage({ text: '第二条', msgId: 2 }),
    ]),
  );
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((event) => (event.kind === 'message' ? event.message.head.msgId : null)),
    [1, 2],
  );
});

test('0x210/277 输入状态', () => {
  const content = encode(INPUT_STATUS_NOTIFY, {
    fromUid: 'u_friend',
    toUid: 'u_self',
    notifyItem: { eventType: 3 },
  });
  const events = decodePushBody(
    envelope([
      {
        responseHead: { fromUin: 20002, fromUid: 'u_friend' },
        contentHead: { msgType: 528, subType: 277, timestamp: 1_700_000_100 },
        body: { msgContent: content },
      },
    ]),
  );
  assert.equal(events.length, 1);
  const event = events[0];
  assert.ok(event && event.kind === 'input-status');
  assert.equal(event.fromUid, 'u_friend');
  assert.equal(event.eventType, 3);
  assert.equal(event.text, '对方正在讲话...');
});

test('0x210/138 好友撤回', () => {
  const content = encode(FRIEND_RECALL, {
    info: { fromUid: 'u_friend', toUid: 'u_self', clientSequence: 777, time: 1_700_000_200 },
  });
  const events = decodePushBody(
    envelope([
      {
        responseHead: { fromUin: 20002, fromUid: 'u_friend' },
        contentHead: { msgType: 528, subType: 138, timestamp: 1_700_000_200 },
        body: { msgContent: content },
      },
    ]),
  );
  const event = events[0];
  assert.ok(event && event.kind === 'friend-recall');
  assert.equal(event.clientSequence, 777);
  assert.equal(event.recalledBySelf, false);
});

test('0x2dc/17 群撤回（7 字节外壳）', () => {
  const payload = encode(GROUP_NOTIFY_BODY, {
    groupUin: 55555,
    operatorUid: 'u_admin',
    recall: {
      operatorUid: 'u_admin',
      recallMessages: [{ sequence: 88, time: 1_700_000_300, authorUid: 'u_author' }],
    },
  });
  const shell = new Uint8Array(7 + payload.length);
  shell[5] = (payload.length >> 8) & 0xff;
  shell[6] = payload.length & 0xff;
  shell.set(payload, 7);

  const events = decodePushBody(
    envelope([
      {
        responseHead: { fromUin: 55555, grp: { groupUin: 55555 } },
        contentHead: { msgType: 732, subType: 17, timestamp: 1_700_000_300 },
        body: { msgContent: shell },
      },
    ]),
  );
  const event = events[0];
  assert.ok(event && event.kind === 'group-recall');
  assert.equal(event.groupUin, 55555);
  assert.equal(event.sequence, 88);
  assert.equal(event.authorUid, 'u_author');
  assert.equal(event.operatorUid, 'u_admin');
});

test('非 MsgPush 命令原样交出（KickNT）', () => {
  const body = new Uint8Array([1, 2, 3]);
  const events = decodePushFrame({
    command: 'trpc.qq_new_tech.status_svc.StatusService.KickNT',
    body,
    seq: 9,
  });
  const event = events[0];
  assert.ok(event && event.kind === 'other');
  assert.deepEqual([...event.body], [1, 2, 3]);
  assert.equal(event.seq, 9);

  assert.equal(decodePushFrame({ command: MSG_PUSH_CMD, body: envelope([]), seq: 1 }).length, 0);
});

test('历史 / 合并转发节点走同一个解码器（PUSH_MSG_BODY）', () => {
  const events = decodeMessageBodies([
    groupMessage({ text: '转发节点', bubble: 5 }) as unknown as RawMessageBody,
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.message.dress.bubble, 5);
});

/**
 * 下面三条覆盖「群名片是结构化 protobuf 却被当字符串解」这个线上问题。
 *
 * 真实样本取自 `logs/weqbot-2026-11-16.log` 里那条打印成
 * `群 [悠悠果冻学院(938098977)] | [%ĀĀÓ\b022…]` 的日志 —— 名片字节是
 * `08 25 c4 80 c4 80 07 c3 93 0a 08 12 06 <text> 10 00`：前 8 字节是版本等
 * 字段（**不是合法 wire 格式**），`0a` = parts（tag 1）、`12` = text（**tag 2**）、
 * `10 00` = control（tag 1）。
 */
const REAL_CARD_BYTES = Uint8Array.from(
  '0825c480c48007c3930a081206e9b1bce584bf1000'.match(/../g)!.map((b) => Number.parseInt(b, 16)),
);

function messageWithCard(card: Uint8Array | undefined, cardType?: number): Record<string, unknown> {
  return {
    responseHead: {
      fromUin: 2535909918,
      fromUid: 'u_sender',
      grp: {
        groupUin: 938098977,
        ...(card ? { memberCard: card } : {}),
        ...(cardType !== undefined ? { memberCardType: cardType } : {}),
        groupName: '悠悠果冻学院',
      },
    },
    contentHead: { msgType: 82, msgId: 7, sequence: 1, timestamp: 1_700_000_000 },
    body: { richText: { elems: [textElem('你好')] } },
  };
}

test('结构化群名片：跳前缀后解出文本，不再打印二进制乱码', () => {
  const events = decodePushBody(envelope([messageWithCard(REAL_CARD_BYTES, 1)]));
  const event = events[0];
  assert.ok(event && event.kind === 'message');
  assert.equal(event.message.sender.name, '鱼儿');
  assert.equal(event.message.sender.card, '鱼儿');
});

test('名片里带控制符的部分不输出文本，也不影响消息本体', () => {
  // part 同时带 control(tag 1) 与 text(tag 2)：按 SnowLuma 口径整段丢弃。
  const controlOnly = Uint8Array.from([0x0a, 0x06, 0x0a, 0x01, 0x14, 0x12, 0x01, 0x41]);
  const events = decodePushBody(envelope([messageWithCard(controlOnly, 1)]));
  const event = events[0];
  assert.ok(event && event.kind === 'message');
  // 名字退化成 undefined（交给身份表），消息本身照常解出。
  assert.equal(event.message.sender.name, undefined);
  assert.deepEqual(event.message.elements, [{ kind: 'text', textContent: '你好' }]);
});

test('memberCardType = 2 是字面昵称，直接按 UTF-8 读', () => {
  const events = decodePushBody(
    envelope([messageWithCard(new TextEncoder().encode('纯文本昵称'), 2)]),
  );
  const event = events[0];
  assert.ok(event && event.kind === 'message');
  assert.equal(event.message.sender.name, '纯文本昵称');
  assert.equal(event.message.sender.card, '纯文本昵称');
});
