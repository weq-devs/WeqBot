/**
 * protobuf 运行时 —— **骨架占位**，P1 从 `WeQ/packages/protocol/src/protobuf.ts`
 * 整体搬运（schema 驱动、无构建步骤、无 codegen）。
 *
 * 为什么不用 `@protobuf-ts/runtime` + `.proto` 代码生成：
 *   - 搬运目标是 `@weq/protocol` 的 161 个 spec 文件，它们全都用这套运行时；
 *   - 协议字段随 QQ 版本变，改一个字段不该触发一次 codegen。
 *
 * 这里只固定**类型形状**，让搬运进来的 spec 能先通过类型检查。
 */

export type ScalarType =
  | 'int32'
  | 'uint32'
  | 'sint32'
  | 'int64'
  | 'uint64'
  | 'bool'
  | 'string'
  | 'bytes'
  | 'float'
  | 'double'
  | 'fixed32'
  | 'fixed64';

export interface ProtoField {
  /** wire 上的 tag。 */
  id: number;
  type: ScalarType | ProtoMessage;
  repeated?: boolean;
  /** 嵌套 message 的简写：`{ id: 2, type: SomeMessage }`。 */
  optional?: boolean;
}

export interface ProtoMessage {
  name: string;
  fields: Record<string, ProtoField>;
}

/** 构造 schema。搬运后行为应与 WeQ 侧完全一致。 */
export function message(name: string, fields: Record<string, ProtoField>): ProtoMessage {
  return { name, fields };
}

export class ProtoNotPortedError extends Error {
  constructor(what: string) {
    super(`${what}：protobuf 运行时尚未搬运（见 TODO P1）`);
    this.name = 'ProtoNotPortedError';
  }
}

export function encode(_schema: ProtoMessage, _value: Record<string, unknown>): Uint8Array {
  throw new ProtoNotPortedError('encode');
}

export function decode(_schema: ProtoMessage, _bytes: Uint8Array): Record<string, unknown> {
  throw new ProtoNotPortedError('decode');
}
