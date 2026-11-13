import assert from 'node:assert/strict';
import test from 'node:test';
import { encode } from '../src/protobuf';
import {
  decodePushBody,
  decodePushFrame,
  MSG_PUSH_ENVELOPE,
  SysMsgDedup,
  CLIENT_MESSAGE_RECEIPT_CMD,
} from '../src/push';
import {
  FRIEND_REQUEST,
  GENERAL_GRAY_TIP,
  GROUP_ADMIN,
  GROUP_CHANGE,
  GROUP_INVITE,
  GROUP_MUTE,
  GROUP_NOTIFY_BODY,
  GROUP_REACT,
  NEW_FRIEND,
  SELF_JOIN_GROUP,
  SEND_MESSAGE_RESPONSE,
  GROUP_JOIN,
} from '../src/push/schemas';

const GROUP = 55555;
const SELF_UIN = 10000;

function wrap(body: Uint8Array): Uint8Array {
  const out = new Uint8Array(7 + body.length);
  out[5] = (body.length >> 8) & 0xff;
  out[6] = body.length & 0xff;
  out.set(body, 7);
  return out;
}

function groupContent(payload: Record<string, unknown>): Uint8Array {
  return wrap(encode(GROUP_NOTIFY_BODY, payload));
}

function notify(msgType: number, subType: number, content: Uint8Array): Uint8Array {
  return encode(MSG_PUSH_ENVELOPE, {
    messages: [
      {
        responseHead: { fromUin: GROUP, fromUid: 'u_group', grp: { groupUin: GROUP } },
        contentHead: { msgType, subType, msgId: 7001, sequence: 9001, timestamp: 1_700_000_000 },
        body: { msgContent: content },
      },
    ],
  });
}

test('33 入群：成员与操作者 uid 都带出来，区分邀请 / 审批', () => {
  const [event] = decodePushBody(
    notify(
      33,
      0,
      encode(GROUP_CHANGE, {
        groupUin: GROUP,
        memberUid: 'u_member',
        decreaseType: 3,
        operatorBytes: new TextEncoder().encode('u_op'),
      }),
    ),
  );
  assert.equal(event?.kind, 'group-member');
  if (event?.kind !== 'group-member') return;
  assert.equal(event.groupUin, GROUP);
  assert.equal(event.memberUid, 'u_member');
  assert.equal(event.operatorUid, 'u_op');
  assert.equal(event.action, 'join');
  assert.equal(event.joinType, 'invite');
});

test('34 退群：129 = 解散，130 = 主动退群', () => {
  const [disband] = decodePushBody(
    notify(
      34,
      0,
      encode(GROUP_CHANGE, { groupUin: GROUP, memberUid: 'u_member', decreaseType: 129 }),
    ),
  );
  assert.equal(disband?.kind, 'group-member');
  if (disband?.kind === 'group-member') {
    assert.equal(disband.action, 'disband');
    assert.equal(disband.leaveType, 'disband');
  }

  const [leave] = decodePushBody(
    notify(
      34,
      0,
      encode(GROUP_CHANGE, { groupUin: GROUP, memberUid: 'u_member', decreaseType: 130 }),
    ),
  );
  assert.equal(leave?.kind, 'group-member');
  if (leave?.kind === 'group-member') {
    assert.equal(leave.action, 'leave');
    assert.equal(leave.leaveType, 'leave');
    assert.equal(leave.operatorUid, 'u_member');
  }
});

test('85 自己入群：groupUin 是 uint64', () => {
  const [event] = decodePushBody(
    notify(85, 0, encode(SELF_JOIN_GROUP, { groupUin: BigInt(GROUP), operatorUid: 'u_op' })),
  );
  assert.equal(event?.kind, 'group-member');
  if (event?.kind === 'group-member') {
    assert.equal(event.action, 'self-join');
    assert.equal(event.groupUin, GROUP);
    assert.equal(event.operatorUid, 'u_op');
  }
});

test('44 管理员变更：只认 extraEnable / extraDisable 里真带 uid 的那一侧', () => {
  const [promote] = decodePushBody(
    notify(
      44,
      0,
      encode(GROUP_ADMIN, { groupUin: GROUP, body: { extraEnable: { adminUid: 'u_admin' } } }),
    ),
  );
  assert.equal(promote?.kind, 'group-admin');
  if (promote?.kind === 'group-admin') {
    assert.equal(promote.memberUid, 'u_admin');
    assert.equal(promote.set, true);
  }

  const [demote] = decodePushBody(
    notify(
      44,
      0,
      encode(GROUP_ADMIN, { groupUin: GROUP, body: { extraDisable: { adminUid: 'u_admin' } } }),
    ),
  );
  assert.equal(demote?.kind, 'group-admin');
  if (demote?.kind === 'group-admin') assert.equal(demote.set, false);
});

test('84 加群申请 / 87 邀请：flag 可直接回填 set_group_add_request', () => {
  const [add] = decodePushBody(
    notify(84, 0, encode(GROUP_JOIN, { groupUin: GROUP, targetUid: 'u_guest' })),
  );
  assert.equal(add?.kind, 'group-request');
  if (add?.kind === 'group-request') {
    assert.equal(add.subType, 'add');
    assert.equal(add.fromUid, 'u_guest');
    assert.equal(add.flag, `add:${GROUP}:u_guest`);
  }

  const [invite] = decodePushBody(
    notify(87, 0, encode(GROUP_INVITE, { groupUin: GROUP, invitorUid: 'u_host' })),
  );
  assert.equal(invite?.kind, 'group-request');
  if (invite?.kind === 'group-request') {
    assert.equal(invite.subType, 'invite');
    assert.equal(invite.flag, `invite:${GROUP}:u_host`);
  }
});

test('0x210/35 好友申请', () => {
  const [event] = decodePushBody(
    notify(
      528,
      35,
      encode(FRIEND_REQUEST, {
        info: { sourceUid: 'u_old', newSource: 'u_new', message: '你好' },
      }),
    ),
  );
  assert.equal(event?.kind, 'friend-request');
  if (event?.kind === 'friend-request') {
    assert.equal(event.fromUid, 'u_new');
    assert.equal(event.message, '你好');
    assert.equal(event.flag, 'u_new');
  }
});

test('0x210/179 新好友', () => {
  const [event] = decodePushBody(
    notify(
      528,
      179,
      encode(NEW_FRIEND, { info: { uid: 'u_friend', nickName: '小明', toUid: 'u_self' } }),
    ),
  );
  assert.equal(event?.kind, 'friend-add');
  if (event?.kind === 'friend-add') {
    assert.equal(event.uid, 'u_friend');
    assert.equal(event.nickname, '小明');
    assert.equal(event.toUid, 'u_self');
  }
});

test('0x210/290 戳一戳：模板里取双方 uid', () => {
  const [event] = decodePushBody(
    notify(
      528,
      290,
      encode(GENERAL_GRAY_TIP, {
        busiType: 12n,
        msgTemplParam: [
          { name: 'uin_str1', value: 'u_a' },
          { name: 'uin_str2', value: 'u_b' },
          { name: 'action_str', value: '拍了拍' },
        ],
      }),
    ),
  );
  assert.equal(event?.kind, 'poke');
  if (event?.kind === 'poke') {
    assert.equal(event.fromUid, 'u_a');
    assert.equal(event.toUid, 'u_b');
    assert.equal(event.action, '拍了拍');
  }
});

test('0x2dc/12 禁言：0xffffffff 归一为 long', () => {
  const [event] = decodePushBody(
    notify(
      732,
      12,
      encode(GROUP_MUTE, {
        groupUin: GROUP,
        operatorUid: 'u_op',
        data: { timestamp: 1_700_000_001, state: { targetUid: 'u_bad', duration: 0xffffffff } },
      }),
    ),
  );
  assert.equal(event?.kind, 'group-mute');
  if (event?.kind === 'group-mute') {
    assert.equal(event.targetUid, 'u_bad');
    assert.equal(event.operatorUid, 'u_op');
    assert.equal(event.duration, 0x7fffffff);
  }
});

test('0x2dc/16 field13=35 表情回应', () => {
  const [event] = decodePushBody(
    notify(
      732,
      16,
      wrap(
        encode(GROUP_REACT, {
          groupUin: BigInt(GROUP),
          field13: 35,
          groupReactionData: {
            data: {
              data: {
                groupReactionTarget: { seq: 123n },
                groupReactionDataContent: {
                  code: '76',
                  count: 2,
                  operatorUid: 'u_liker',
                  type: 1,
                },
              },
            },
          },
        }),
      ),
    ),
  );
  assert.equal(event?.kind, 'group-reaction');
  if (event?.kind === 'group-reaction') {
    assert.equal(event.sequence, 123);
    assert.equal(event.code, '76');
    assert.equal(event.count, 2);
    assert.equal(event.operatorUid, 'u_liker');
    assert.equal(event.added, true);
  }
});

test('0x2dc/21 群精华', () => {
  const [event] = decodePushBody(
    notify(
      732,
      21,
      groupContent({
        groupUin: GROUP,
        essenceMessage: {
          groupUin: GROUP,
          msgSequence: 777,
          setFlag: 1,
          memberUin: SELF_UIN,
          timestamp: 1_700_000_002,
        },
      }),
    ),
  );
  assert.equal(event?.kind, 'group-essence');
  if (event?.kind === 'group-essence') {
    assert.equal(event.sequence, 777);
    assert.equal(event.memberUin, SELF_UIN);
    assert.equal(event.set, true);
    assert.equal(event.time, 1_700_000_002);
  }
});

test('空消息（无元素、无 msgContent）被丢弃', () => {
  const events = decodePushBody(notify(82, 0, new Uint8Array(0)));
  assert.deepEqual(events, []);
});

test('SysMsgDedup：同一系统推送第二次直接丢弃', () => {
  const body = notify(
    732,
    12,
    encode(GROUP_MUTE, {
      groupUin: GROUP,
      operatorUid: 'u_op',
      data: { state: { targetUid: 'u_bad', duration: 60 } },
    }),
  );
  const dedup = new SysMsgDedup();
  assert.equal(decodePushBody(body, { dedup }).length, 1);
  assert.equal(decodePushBody(body, { dedup }).length, 0);
});

test('ClientMessageReceipt：解出 peer / clientSequence / 服务端序号', () => {
  const peer = new TextEncoder().encode('u_peer');
  const ack = encode(SEND_MESSAGE_RESPONSE, {
    result: 0,
    privateSequence: 424242,
    timestamp1: 1_700_000_003,
  });
  const body = new Uint8Array(8 + peer.length + ack.length);
  body[0] = 1;
  body[1] = peer.length;
  body[4] = 7; // clientSequence = 7
  body.set(peer, 8);
  body.set(ack, 8 + peer.length);

  const events = decodePushFrame({
    command: CLIENT_MESSAGE_RECEIPT_CMD,
    body,
    seq: 1,
  });
  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event?.kind, 'client-receipt');
  if (event?.kind === 'client-receipt') {
    assert.equal(event.peerUid, 'u_peer');
    assert.equal(event.clientSequence, 7);
    assert.equal(event.sequence, 424242);
    assert.equal(event.time, 1_700_000_003);
  }
});
