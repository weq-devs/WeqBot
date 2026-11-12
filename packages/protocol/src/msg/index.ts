/**
 * 消息编解码。
 *
 * 搬运目标（保持文件名，方便对照）：
 *   - `WeQ/packages/protocol/src/msg/{send,send-elements,send-schemas,schemas}.ts`
 *   - `WeQ/packages/protocol/src/msg/{decode,recall,send-forward,get-forward}.ts`
 *   - `WeQ/packages/codec/src/element/*`（元素词表 + registry）
 *
 * 方向：**入站**（push → Message）与**出站**（Message → wire）必须共用同一份元素词表，
 * 否则 OneBot 适配层要维护两套 id 映射 —— 这是 SnowLuma 里 `element-builder` 与
 * `msg-push/decoders` 放同一个包的原因，我们照做。
 *
 * TODO(P3)：`encodeMessage` / `decodeMessage` 落地前，OneBot 适配层只支持文本。
 */

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
