/**
 * 字节工具。
 *
 * 约定：凭据、签名、wire 上的一切都用 `Uint8Array`；只有在日志和配置里才转 hex。
 * 原生侧收 `Buffer`，边界在 `@weqbot/wire` 统一转换。
 */

export function toHex(bytes: Uint8Array, upper = false): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return upper ? out.toUpperCase() : out;
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error(`hex 长度必须是偶数：${clean.length}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const byte = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`hex 含非法字符：${clean.slice(i * 2, i * 2 + 2)}`);
    out[i] = byte;
  }
  return out;
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}
