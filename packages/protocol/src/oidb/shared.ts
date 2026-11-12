/**
 * 协议层共用小工具 —— 从 `WeQ/packages/protocol/src/oidb/shared.ts` 搬运。
 */

/** 把可能超出 2^53 的 wire 整数（int64/uint64）收成 number，越界时保持字符串。 */
export function toInt(value: unknown): number | string | bigint | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string') return value;
  if (ArrayBuffer.isView(value))
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString();
  return undefined;
}

/** OIDB 回包里的 `retCode` 归零检查；非零时抛出带命令名的错误。 */
export function ensureRetCodeZero(
  retCode: number | string | bigint | undefined,
  what: string,
): void {
  if (retCode === undefined) return;
  const code = typeof retCode === 'string' ? Number.parseInt(retCode, 10) : Number(retCode);
  if (code === 0) return;
  throw new Error(`${what} 失败：retCode=${code}`);
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}
