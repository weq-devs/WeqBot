import assert from 'node:assert/strict';
import test from 'node:test';
import { ListFilesets, ListFilesetsPage } from '../src/oidb/flashtransfer/extended';
import type { OidbNative } from '../src/transport';

const hex = (value: string) => Buffer.from(value, 'hex');

test('preserves the legacy wire request and passes opaque bytes on the paged path', async () => {
  const requests: unknown[] = [];
  const replies = [hex('0a050a036f6e65'), hex('1002220300ff80'), hex('1801')];
  const nt: OidbNative = {
    sendOidbPacket: async (_id, command, subCommand, body, uinForm) => {
      requests.push([command, subCommand, Buffer.from(body).toString('hex'), uinForm]);
      return replies.shift()!;
    },
  };

  assert.equal((await ListFilesets.invoke(nt, 1))[0]?.filesetUuid, 'one');
  const first = await ListFilesetsPage.invoke(nt, 1, { limit: 1 });
  assert.deepEqual(first, { entries: [], total: 2, nextCursor: Uint8Array.of(0, 255, 128) });
  const last = await ListFilesetsPage.invoke(nt, 1, { limit: 1, cursor: first.nextCursor! });
  assert.deepEqual(last, { entries: [], total: null, nextCursor: null });
  assert.deepEqual(requests, [
    [0x93d2, 1, '0803180a', false],
    [0x93d2, 1, '08031801', true],
    [0x93d2, 1, '0803120300ff801801', true],
  ]);
});

test('distinguishes confirmed empty, unconfirmed, malformed and repeated pages', async () => {
  const read = (reply: string, cursor?: Uint8Array) =>
    ListFilesetsPage.invoke(
      { sendOidbPacket: async () => hex(reply) },
      1,
      cursor ? { cursor } : {},
    );
  assert.deepEqual(await read('10001801'), { entries: [], total: 0, nextCursor: null });
  await assert.rejects(read(''), /未确认末页/);
  await assert.rejects(read('1800'), /未确认末页/);
  await assert.rejects(read('18010a06'), /truncated/);
  await assert.rejects(read('1800220101', Uint8Array.of(1)), /相同的续页游标/);
});
