import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyForwardFile, publishForwardedFile } from '../src/file/file-forward';
import { decode, message } from '../src/protobuf';

const source = { fileId: 'old', fileName: 'a.txt', fileSize: 17 };

test('private file forwards with the source UUID and uses the returned UUID and CRC', async () => {
  const file = await copyForwardFile(
    {
      sendOidbPacket: async (_id, cmd, sub, bytes) => {
        assert.deepEqual([cmd, sub], [0xe37, 700]);
        const request = decode(
          message([
            {
              name: 'copy',
              tag: 9,
              type: message([
                { name: 'source', tag: 10, type: 'string' },
                { name: 'target', tag: 20, type: 'string' },
                { name: 'uuid', tag: 30, type: 'string' },
              ]),
            },
            { name: 'client', tag: 102, type: 'uint32' },
          ]),
          bytes,
        );
        assert.deepEqual(request, {
          client: 103,
          copy: { source: 'u_self', target: 'u_other', uuid: 'old' },
        });
        // tag 9 { 50: "new", 60: "crc" }, independently encoded fixture.
        return Buffer.from('4a0c9203036e6577e20303637263', 'hex');
      },
    },
    1,
    source,
    'u_self',
    { userUid: 'u_other' },
  );
  assert.equal(file.fileId, 'new');
  assert.equal(file.fileHash, 'crc');
});

test('group copy can be published with the returned file id and bus id, without highway', async () => {
  const calls: number[] = [];
  const nt = {
    sendPacket: async () => {
      throw new Error('unexpected packet');
    },
    sendOidbPacket: async (_id: number, cmd: number, sub: number, bytes: Uint8Array) => {
      assert.equal(cmd, 0x6d9);
      calls.push(sub);
      if (sub === 2) {
        assert.ok(Buffer.from(bytes).includes(Buffer.from('old')));
        // tag 3 { 4: "new", 5: 105 }
        return Buffer.from('1a0722036e65772869', 'hex');
      }
      assert.ok(Buffer.from(bytes).includes(Buffer.from('new')));
      return Buffer.alloc(0);
    },
  };
  const target = { groupId: 456 };
  const file = await copyForwardFile(nt, 1, { ...source, groupId: 123 }, 'u_self', target);
  assert.equal(file.busId, 105);
  assert.deepEqual(await publishForwardedFile(nt, 1, target, file), { ok: true, fileId: 'new' });
  assert.deepEqual(calls, [2, 4]);
});

test('an expired or incomplete copy is not treated as an attachment', async () => {
  for (const body of ['1a0b0899ffffffffffffffff01', '1a00']) {
    await assert.rejects(
      copyForwardFile(
        { sendOidbPacket: async () => Buffer.from(body, 'hex') },
        1,
        { ...source, groupId: 123 },
        'u_self',
        { groupId: 456 },
      ),
    );
  }
});

test('cross-conversation copies use the destination group or the destination UID', async () => {
  const toGroup = await copyForwardFile(
    {
      sendOidbPacket: async (_id, cmd, sub, bytes) => {
        assert.deepEqual([cmd, sub], [0xe37, 60100]);
        const { copy } = decode(
          message([
            {
              name: 'copy',
              tag: 90000,
              type: message([
                { name: 'target', tag: 10, type: 'uint64' },
                { name: 'bus', tag: 30, type: 'uint32' },
                { name: 'uuid', tag: 80, type: 'string' },
              ]),
            },
          ]),
          bytes,
        );
        assert.deepEqual(copy, { target: 456n, bus: 102, uuid: 'old' });
        return Buffer.from('82f92b05f201026964', 'hex');
      },
    },
    1,
    source,
    'u_self',
    { groupId: 456 },
  );
  assert.equal(toGroup.fileId, 'id');

  const toPrivate = await copyForwardFile(
    {
      sendOidbPacket: async (_id, cmd, sub, bytes) => {
        assert.deepEqual([cmd, sub], [0x6d9, 2]);
        const { copy } = decode(
          message([
            {
              name: 'copy',
              tag: 3,
              type: message([
                { name: 'source', tag: 1, type: 'uint64' },
                { name: 'bus', tag: 5, type: 'uint32' },
                { name: 'target', tag: 6, type: 'string' },
              ]),
            },
          ]),
          bytes,
        );
        assert.deepEqual(copy, { source: 123n, bus: 3, target: 'u_other' });
        return Buffer.from('1a0522036e6577', 'hex');
      },
    },
    1,
    { ...source, groupId: 123 },
    'u_self',
    { userUid: 'u_other' },
  );
  assert.equal(toPrivate.fileId, 'new');
});
