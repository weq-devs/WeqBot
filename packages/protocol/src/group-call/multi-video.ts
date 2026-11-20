/** 主叫收到的 MultiVideo JCE 通知及其回执。 */
export const GROUP_MULTI_VIDEO_PUSH = 'MultiVideo.s2c';
export const GROUP_MULTI_VIDEO_ACK = 'MultiVideo.s2cack';

const requestHeader = Uint8Array.of(0x10, 2, 0x2c, 0x3c);
const requestTail = Uint8Array.of(0x8c, 0x98, 0x0c, 0xa8, 0x0c);
const method = jceString(6, 'MultiVideoMsg');
const mapPrefix = join(
  Uint8Array.of(0x08, 0x00, 1),
  jceString(0, 'MultiVideoMsg'),
  Uint8Array.of(0x18, 0x00, 1),
  jceString(0, 'SharpSvrPack.MultiVideoMsg'),
);

/** 保留内层通知字段，清空 tag 5 的通知载荷，组装主叫回执。 */
export function buildGroupMultiVideoAck(body: Uint8Array): Uint8Array | null {
  try {
    const packet = new JceCursor(body);
    packet.expect(requestHeader);
    packet.integer(4);
    packet.expect(jceString(5, 'MultiVideo'));
    packet.expect(method);
    const maps = new JceCursor(packet.bytes(7));
    packet.expect(requestTail);
    if (packet.offset !== body.length) return null;

    maps.expect(mapPrefix);
    const notice = maps.bytes(1);
    if (maps.offset !== maps.data.length || notice.at(-1) !== 0x0b) return null;

    const inner = new JceCursor(notice);
    inner.expect(Uint8Array.of(0x0a));
    for (let tag = 0; tag <= 3; tag++) inner.integer(tag);
    inner.expect(Uint8Array.of(0x49));
    const users = inner.integer(0);
    if (users < 0 || users > notice.length - inner.offset) return null;
    for (let i = 0; i < users; i++) inner.integer(0);
    const beforePayload = inner.offset;
    inner.bytes(5);
    const reply = join(
      notice.subarray(0, beforePayload),
      jceBytes(5, new Uint8Array()),
      notice.subarray(inner.offset),
    );
    return join(
      requestHeader,
      Uint8Array.of(0x4c),
      jceString(5, GROUP_MULTI_VIDEO_ACK),
      method,
      jceBytes(7, join(mapPrefix, jceBytes(1, reply))),
      requestTail,
    );
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return null;
  }
}

class JceCursor {
  offset = 0;

  constructor(readonly data: Uint8Array) {}

  private take(count: number): Uint8Array {
    if (count < 0 || count > this.data.length - this.offset) throw new RangeError('JCE 字段越界');
    const value = this.data.subarray(this.offset, this.offset + count);
    this.offset += count;
    return value;
  }

  expect(bytes: Uint8Array): void {
    const actual = this.take(bytes.length);
    if (!bytes.every((value, i) => value === actual[i])) throw new RangeError('JCE 字段不匹配');
  }

  integer(tag: number): number {
    const header = this.take(1)[0]!;
    const type = header & 0xf;
    if (header >>> 4 !== tag || (type > 3 && type !== 12))
      throw new RangeError('JCE 整数字段不匹配');
    if (type === 12) return 0;
    const value = this.take(2 ** type);
    const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
    switch (type) {
      case 0:
        return view.getInt8(0);
      case 1:
        return view.getInt16(0);
      case 2:
        return view.getInt32(0);
      default:
        return Number(view.getBigInt64(0));
    }
  }

  bytes(tag: number): Uint8Array {
    this.expect(Uint8Array.of((tag << 4) | 0x0d, 0x00));
    return this.take(this.integer(0));
  }
}

function jceString(tag: number, ascii: string): Uint8Array {
  return Uint8Array.of((tag << 4) | 6, ascii.length, ...new TextEncoder().encode(ascii));
}

function jceBytes(tag: number, bytes: Uint8Array): Uint8Array {
  const length = bytes.length;
  const header = [(tag << 4) | 0x0d, 0x00];
  if (length === 0) header.push(0x0c);
  else if (length <= 0x7f) header.push(0x00, length);
  else if (length <= 0x7fff) header.push(0x01, length >>> 8, length & 0xff);
  else
    header.push(0x02, length >>> 24, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff);
  return join(Uint8Array.from(header), bytes);
}

function join(...parts: Uint8Array[]): Uint8Array {
  const data = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    data.set(part, offset);
    offset += part.length;
  }
  return data;
}
