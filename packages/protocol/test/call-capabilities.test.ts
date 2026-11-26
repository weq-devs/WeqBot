import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePb, pbBytes, pbGetBytes, pbGetVarint, pbVarint } from '../src/call/gcs';
import {
  C2C_CREATE_ROOM_RSP,
  C2C_SSO_CMD,
  type CallSignalingNative,
  startC2CCall,
} from '../src/call/signaling';
import { encode } from '../src/protobuf';

// 2026-11-26 QQ 两种入口的声明字段。账号和回包凭据使用离线夹具。
for (const { label, media, f3, fixed32Hex } of [
  { label: '默认语音', media: undefined, f3: 1, fixed32Hex: '25527d0000' },
  { label: '显式语音', media: 'audio', f3: 1, fixed32Hex: '25527d0000' },
  { label: '直接视频', media: 'video', f3: 0, fixed32Hex: '255c380000' },
] as const) {
  test(`${label}入口发送与 QQ 样本一致的开房和邀请声明`, async () => {
    const sent: { cmd: string; body: Buffer }[] = [];
    const native: CallSignalingNative = {
      async sendPacket(sessionId, cmd, body) {
        assert.equal(sessionId, 1);
        sent.push({ cmd, body });
        if (cmd === C2C_SSO_CMD.createRoom) {
          return Buffer.from(
            encode(C2C_CREATE_ROOM_RSP, {
              common: { roomId: 777n, sessionId: 88n, relationId: 15001, scene: 1 },
              params: { authKey: new Uint8Array(80).fill(1), servers: [] },
            }),
          );
        }
        assert.equal(cmd, C2C_SSO_CMD.inviteUser);
        return Buffer.from(pbBytes(4, pbVarint(2, 1234)));
      },
    };

    const result = await startC2CCall(native, 1, {
      selfUid: 'u_self',
      peerUid: 'u_peer',
      media,
    });
    assert.equal(result.room.roomId, 777n);
    assert.equal(result.authToken, 1234);
    assert.deepEqual(
      sent.map(({ cmd }) => cmd),
      [C2C_SSO_CMD.createRoom, C2C_SSO_CMD.inviteUser],
    );

    const createCommon = pbGetBytes(sent[0]!.body, 1)!;
    const createParams = pbGetBytes(sent[0]!.body, 2)!;
    assert.equal(pbGetVarint(createCommon, 4), 1);
    assert.equal(pbGetVarint(createParams, 3), f3);
    assert.equal(pbGetVarint(createParams, 13), 1);
    // 前三个字段均为显式单字节 varint，随后是 f4 的 tag 与四字节小端值。
    assert.equal(parsePb(createParams).find(({ field }) => field === 4)?.wire, 5);
    assert.equal(Buffer.from(createParams.subarray(6, 11)).toString('hex'), fixed32Hex);

    const inviteCommon = pbGetBytes(sent[1]!.body, 1)!;
    const inviteParams = pbGetBytes(sent[1]!.body, 3)!;
    assert.equal(pbGetVarint(inviteCommon, 1), 777);
    assert.equal(pbGetVarint(inviteCommon, 2), undefined);
    assert.equal(pbGetVarint(inviteCommon, 3), pbGetVarint(createCommon, 3)! + 1);
    assert.equal(pbGetVarint(inviteCommon, 4), 4);
    assert.equal(Buffer.from(inviteParams).toString('hex'), '180120d14e280060006800');
  });
}
