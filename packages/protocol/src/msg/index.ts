/**
 * 消息编解码。
 *
 * 搬运目标（保持文件名，方便对照）：
 *   - `WeQ/packages/protocol/src/msg/{send,send-elements,send-schemas,schemas}.ts`
 *   - `WeQ/packages/protocol/src/msg/{decode,recall,send-forward,get-forward}.ts`
 *
 * 方向：**入站**（push → Message）与**出站**（Message → wire）必须共用同一份元素词表，
 * 否则 OneBot 适配层要维护两套 id 映射 —— 这是 SnowLuma 里 `element-builder` 与
 * `msg-push/decoders` 放同一个包的原因，我们照做。
 *
 * ⚠️ **不要从 `@weq/codec` 搬任何东西**：那个包是**解数据库**用的（`SqlRow` + schema DSL
 * → 元素 / 域模型），与 wire 协议是两套模型，字段语义也不同。它的 `src/element/types.ts`
 * 看起来像元素词表，实际上带着库表列的假设（例如灰度、撤回时间由图区提供）。
 * 消息元素词表就是本目录 `schemas.ts` 里的 `ELEM`，OneBot 的 segment 词表在
 * `@weqbot/onebot`，两层之间只做形状翻译。
 *
 * TODO(P3)：`encodeMessage` / `decodeMessage` 落地前，OneBot 适配层只支持文本。
 */

export * from './dataline';
export * from './schemas';
export * from './send-schemas';

export type {
  AtElement,
  FaceElement,
  ImageElement,
  Message,
  MessageElement,
  ReplyElement,
  TextElement,
  UnknownElement,
} from './spec';
