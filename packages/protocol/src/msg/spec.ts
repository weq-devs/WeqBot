/**
 * 消息元素（骨架版）。
 *
 * 真实的元素词表很大（Ark / 卡片 / 表情 / 文件 / 语音 / 合并转发 …），P3 从
 * `WeQ/packages/codec/src/element/{types,spec,registry}.ts` 整体搬运。这里先固定
 * **OneBot 适配真正依赖的那几种**，让上层能先跑通文本链路。
 *
 * 约定：元素是**纯数据**，encode/decode 在 `msg/element.ts`；不要把 buf/id 之类
 * 的运行时句柄塞进元素里。
 */

export interface TextElement {
  type: 'text';
  text: string;
}

export interface FaceElement {
  type: 'face';
  /** QQ 表情 id（不是 unicode）。 */
  id: number;
  /** 部分场景带扩展字段（超级表情）。 */
  ext?: string;
}

export interface AtElement {
  type: 'at';
  /** 目标 uid；`'all'` 表示 @全体。 */
  uid: string;
}

export interface ReplyElement {
  type: 'reply';
  /** 被回复消息的 wire id（`msg_id`）。 */
  messageId: string;
  /** 部分协议版本同时带 seq。 */
  seq?: number;
}

export interface ImageElement {
  type: 'image';
  /** 本地路径 / URL / 已上传的 file uuid，语义由 encode 阶段决定。 */
  source: string;
  /** 服务端返回的 file uuid（收到时才有）。 */
  fileUuid?: string;
  width?: number;
  height?: number;
  subType?: number;
}

export interface UnknownElement {
  type: 'unknown';
  /** 原始 wire 上的元素编号，便于排查。 */
  elementId: number;
  /** 原始 payload，hex。 */
  raw: string;
}

export type MessageElement =
  | TextElement
  | FaceElement
  | AtElement
  | ReplyElement
  | ImageElement
  | UnknownElement;

export type Message = MessageElement[];
