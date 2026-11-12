/**
 * 消息元素（骨架版）。
 *
 * 真实的元素形状由 `./decode.ts` 与 `./send-elements.ts` 的输出/入参定义（例如
 * `{ kind: 'text', textContent }`），`./schemas.ts` 的 `ELEM` 是它们的 wire 来源。
 * 本文件只是骨架期给 OneBot 适配层用的中间类型，P4 收尾时会被真实形状取代。
 * **不要引入 `@weq/codec`** —— 那是解数据库的模型，不是网线协议模型。
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
