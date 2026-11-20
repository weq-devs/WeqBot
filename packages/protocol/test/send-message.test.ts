import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSendRequest, buildSendRequestWithMedia } from '../src/msg/send';
import { SEND_MESSAGE_REQUEST } from '../src/msg/send-schemas';
import { decode } from '../src/protobuf';

test('PbSendMsg private text uses UID routing and encodes the zero ContentHead fields', async () => {
  const { bytes } = await buildSendRequestWithMedia({
    userUin: 123,
    userUid: 'u_test',
    elements: [{ kind: 'text', textContent: 'hi' }],
    clientSequence: 5,
    random: 7,
    msgFlag: 123,
  });

  assert.equal(
    Buffer.from(bytes).toString('hex'),
    '0a0a0a081206755f7465737412060801100018001a0a0a0812060a040a026869200528073202087b',
  );
});

test('PbSendMsg group text includes the default dress elements before the text', async () => {
  const { bytes } = await buildSendRequestWithMedia({
    groupId: 123,
    elements: [{ kind: 'text', textContent: 'hi' }],
    clientSequence: 5,
    random: 7,
  });

  assert.equal(
    Buffer.from(bytes).toString('hex'),
    '0a041202087b12060801100018001a580a561246aa024308008001008801009a0138' +
      '78808004c80100f00100f80100900200c80200980302a00308b00300b80300c00300b80402c00400' +
      'ca040a0800100018002000380080060012044a02080012060a040a02686920052807',
  );
});

test('PbSendMsg group messages encode an increasing client sequence by default', () => {
  const params = {
    groupId: 123,
    elements: [{ kind: 'text' as const, textContent: 'hi' }],
    random: 7,
  };
  const first = buildSendRequest(params);
  const second = buildSendRequest(params);

  assert.ok(first.clientSequence > 0);
  assert.equal(second.clientSequence, first.clientSequence + 1);
  assert.equal(decode(SEND_MESSAGE_REQUEST, first.bytes).clientSequence, first.clientSequence);
  assert.equal(decode(SEND_MESSAGE_REQUEST, second.bytes).clientSequence, second.clientSequence);
});
