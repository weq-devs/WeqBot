// QQNT 服务端方向帧。按 native 原生解码与真实推送逐字节对照。
import { randomBytes } from 'node:crypto';
import { inflateSync } from 'node:zlib';

const DELTA = 0x9e3779b9;

export function teaBlock(block: Buffer, key: Buffer, decrypt = false) {
  if (block.length !== 8 || key.length !== 16) throw new Error('Invalid TEA block/key size');
  let x = block.readUInt32BE(0);
  let y = block.readUInt32BE(4);
  const a = key.readUInt32BE(0),
    b = key.readUInt32BE(4),
    c = key.readUInt32BE(8),
    d = key.readUInt32BE(12);
  let sum = decrypt ? (DELTA * 16) >>> 0 : 0;
  for (let round = 0; round < 16; round++) {
    if (decrypt) {
      y = (y - (((x + sum) >>> 0) ^ (((x << 4) + c) >>> 0) ^ ((x >>> 5) + d))) >>> 0;
      x = (x - (((y + sum) >>> 0) ^ (((y << 4) + a) >>> 0) ^ ((y >>> 5) + b))) >>> 0;
      sum = (sum - DELTA) >>> 0;
    } else {
      sum = (sum + DELTA) >>> 0;
      x = (x + (((y + sum) >>> 0) ^ (((y << 4) + a) >>> 0) ^ ((y >>> 5) + b))) >>> 0;
      y = (y + (((x + sum) >>> 0) ^ (((x << 4) + c) >>> 0) ^ ((x >>> 5) + d))) >>> 0;
    }
  }
  const result = Buffer.alloc(8);
  result.writeUInt32BE(x, 0);
  result.writeUInt32BE(y, 4);
  return result;
}

function xor(left: Buffer, right: Buffer) {
  return Buffer.from(left.map((value, index) => value ^ right[index]!));
}

export function qqteaEncrypt(plaintext: Buffer, key: Buffer) {
  const fill = 10 - ((plaintext.length + 1) & 7);
  const padded = Buffer.concat([randomBytes(fill), plaintext, Buffer.alloc(7)]);
  padded[0] = (fill - 3) | 0xf8;
  const output = Buffer.alloc(padded.length);
  let previousCipher: Buffer = Buffer.alloc(8);
  let previousMixed: Buffer = Buffer.alloc(8);
  for (let offset = 0; offset < padded.length; offset += 8) {
    const mixed = xor(padded.subarray(offset, offset + 8), previousCipher);
    const cipher = xor(teaBlock(mixed, key), previousMixed);
    cipher.copy(output, offset);
    previousCipher = cipher;
    previousMixed = mixed;
  }
  return output;
}

export function qqteaDecrypt(ciphertext: Buffer, key: Buffer) {
  if (ciphertext.length < 16 || ciphertext.length % 8) throw new Error('Invalid QQTEA length');
  const output = Buffer.alloc(ciphertext.length);
  let previousCipher: Buffer = Buffer.alloc(8);
  let previousMixed: Buffer = Buffer.alloc(8);
  for (let offset = 0; offset < ciphertext.length; offset += 8) {
    const cipher = ciphertext.subarray(offset, offset + 8);
    const mixed = teaBlock(xor(cipher, previousMixed), key, true);
    xor(mixed, previousCipher).copy(output, offset);
    previousCipher = cipher;
    previousMixed = mixed;
  }
  const fill = (output[0]! & 7) + 3;
  if (fill + 7 > output.length || output.subarray(-7).some((value) => value !== 0)) {
    throw new Error('Invalid QQTEA padding');
  }
  return output.subarray(fill, -7);
}

function uint32(value: number) {
  const result = Buffer.alloc(4);
  result.writeUInt32BE(value);
  return result;
}

function prefixed(bytes: Buffer) {
  return Buffer.concat([uint32(bytes.length + 4), bytes]);
}

class Cursor {
  offset = 0;
  constructor(readonly bytes: Buffer) {}
  take(length: number) {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.bytes.length) {
      throw new Error('Truncated frame');
    }
    const result = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }
  u32() {
    return this.take(4).readUInt32BE();
  }
  prefixed() {
    return this.take(this.u32() - 4);
  }
  rest() {
    return this.take(this.bytes.length - this.offset);
  }
}

export interface ServerPacket {
  sequence: number;
  command: string;
  body: Buffer;
  retCode?: number;
  extra?: Buffer;
  cookies?: Buffer;
  dataFlag?: number;
  reserved?: Buffer;
  headTail?: Buffer;
}

export function buildServerPlain({
  sequence,
  command,
  body,
  retCode = 0,
  extra = Buffer.alloc(0),
  cookies = Buffer.alloc(0),
  dataFlag = 0,
  reserved = Buffer.alloc(0),
  headTail = Buffer.alloc(0),
}: ServerPacket) {
  const status = Buffer.alloc(4);
  status.writeInt32BE(retCode);
  const head = Buffer.concat([
    uint32(sequence),
    status,
    prefixed(extra),
    prefixed(Buffer.from(command)),
    prefixed(cookies),
    uint32(dataFlag),
    prefixed(reserved),
    headTail,
  ]);
  return Buffer.concat([prefixed(head), prefixed(body)]);
}

export function parseServerPlain(plain: Buffer) {
  const outer = new Cursor(plain);
  const head = new Cursor(outer.prefixed());
  const body = outer.prefixed();
  if (outer.rest().length) throw new Error('Trailing service payload');
  const sequence = head.u32();
  const retCode = head.take(4).readInt32BE();
  const extra = head.prefixed();
  const command = head.prefixed().toString();
  const cookies = head.prefixed();
  const dataFlag = head.u32();
  const reserved = head.prefixed();
  const headTail = head.rest();
  return { sequence, retCode, extra, command, cookies, dataFlag, reserved, headTail, body };
}

export function decodedBody(packet: ServerPacket) {
  return packet.dataFlag === 1
    ? inflateSync(packet.body, { maxOutputLength: 16 * 1024 * 1024 })
    : packet.body;
}

export function buildServerFrame({
  uin,
  plain,
  key,
  protocol = 12,
  encryption = 1,
  flag = 0,
}: {
  uin: string;
  plain: Buffer;
  key: Buffer;
  protocol?: number;
  encryption?: number;
  flag?: number;
}) {
  if (![12, 13].includes(protocol) || ![0, 1, 2].includes(encryption))
    throw new Error('Unknown framing');
  const payload =
    encryption === 0 ? plain : qqteaEncrypt(plain, encryption === 2 ? Buffer.alloc(16) : key);
  return prefixed(
    Buffer.concat([
      uint32(protocol),
      Buffer.from([encryption, flag]),
      prefixed(Buffer.from(uin)),
      payload,
    ]),
  );
}

export function parseServerFrame(raw: Buffer, key: Buffer) {
  const cursor = new Cursor(raw);
  if (cursor.u32() !== raw.length) throw new Error('Length mismatch');
  const protocol = cursor.u32();
  const encryption = cursor.take(1)[0]!;
  const flag = cursor.take(1)[0]!;
  const uin = cursor.prefixed().toString();
  if (![12, 13].includes(protocol) || ![0, 1, 2].includes(encryption))
    throw new Error('Unknown framing');
  const payload = cursor.rest();
  const plain =
    encryption === 0 ? payload : qqteaDecrypt(payload, encryption === 2 ? Buffer.alloc(16) : key);
  return { protocol, encryption, flag, uin, plain };
}
