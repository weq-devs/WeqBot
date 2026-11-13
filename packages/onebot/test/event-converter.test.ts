/** `BotEvent` → OneBot post 的映射。 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { InboundMessage, NoticeEvent } from '@weqbot/session';
import { convertMessage, convertNotice } from '../src/event-converter';

const SELF = 10001;

function context() {
  let next = 1;
  return {
    selfId: SELF,
    messageFormat: 'array' as const,
    reportSelfMessage: true,
    internMessageId: () => next++,
  };
}

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: '88',
    seq: 1,
    time: 1_700_000_000,
    scene: 'group',
    peer: { id: '55555', name: '测试群' },
    sender: { id: '20002', name: '群友' },
    self: { uin: String(SELF) },
    elements: [{ kind: 'text', textContent: 'hi' }],
    ...overrides,
  };
}

test('群消息 → post_type message + group 字段', async () => {
  const post = await convertMessage(context(), message());
  assert.equal(post.post_type, 'message');
  assert.equal(post.message_type, 'group');
  assert.equal(post.group_id, 55555);
  assert.equal(post.user_id, 20002);
  assert.equal(post.message_id, 1);
  assert.equal(post.raw_message, 'hi');
});

test('私聊消息 → user_id 为对方', async () => {
  const post = await convertMessage(
    context(),
    message({ scene: 'private', peer: { id: '20002' } }),
  );
  assert.equal(post.message_type, 'private');
  assert.equal(post.sub_type, 'friend');
  assert.equal(post.user_id, 20002);
});

test('自己发的消息 → message_sent', async () => {
  const post = await convertMessage(context(), message({ sender: { id: String(SELF) } }));
  assert.equal(post.post_type, 'message_sent');
});

test('string 格式的连接拿到 CQ 串', async () => {
  const post = await convertMessage({ ...context(), messageFormat: 'string' as const }, message());
  assert.equal(post.message, 'hi');
});

test('装扮随消息带出', async () => {
  const post = await convertMessage(
    context(),
    message({ dress: { bubble: 12, font: 3, widget: 0 } }),
  );
  assert.deepEqual(post.dress, { bubble: 12, font: 3, widget: 0 });
});

test('撤回通知 → group_recall', async () => {
  const event: NoticeEvent = {
    type: 'notice',
    kind: 'message-recall',
    at: 1_700_000_000_000,
    peer: { id: '55555' },
    sender: { id: '20002' },
    messageId: '88',
  };
  const post = await convertNotice(context(), event);
  assert.equal(post?.notice_type, 'group_recall');
  assert.equal(post?.message_id, 88);
});

test('输入状态 → notify/input_status', async () => {
  const event: NoticeEvent = {
    type: 'notice',
    kind: 'input-status',
    at: 1_700_000_000_000,
    peer: { id: '20002' },
    eventType: 1,
    text: '对方正在输入...',
  };
  const post = await convertNotice(context(), event);
  assert.equal(post?.notice_type, 'notify');
  assert.equal(post?.sub_type, 'input_status');
  assert.equal(post?.event_type, 1);
});

test('未建模的通知返回 null', async () => {
  const event: NoticeEvent = {
    type: 'notice',
    kind: 'other',
    at: 1,
    name: 'unknown',
  };
  assert.equal(await convertNotice(context(), event), null);
});
