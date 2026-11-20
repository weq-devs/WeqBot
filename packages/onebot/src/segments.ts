/**
 * OneBot segment ⇄ 协议元素：**双向只写一张表**。
 *
 * 设计来自 SnowLuma `packages/onebot/src/event-converter/element-codecs.ts`
 * （2026-11-13）：历史上「元素 → segment」与「segment → 元素」分散在两个文件各写
 * 一套，改一边忘另一边就漂。这里每种元素一条 `{ toSegment?, fromSegment? }`，
 * 缺了哪个方向一眼可见。
 *
 * 元素形状由 `@weqbot/protocol` 决定（`msg/decode.ts` 的 `kind` 判别对象 /
 * `msg/send-elements.ts` 的 `SendElement`）。两边同名同形，所以可以原样对喂 ——
 * 收到 `{kind:'text', textContent}` 转成 segment 再发出去，语义不变。
 */

import type { JsonObject } from './types';

/** OneBot segment 的规范形状（`message` 参数 / 事件里的 `message` 数组）。 */
export interface Segment {
  type: string;
  data: Record<string, unknown>;
}

/** 入站元素（`decode.ts` 的产物）。字段都是可选的，因为不同消息只带其中一部分。 */
export interface InboundElement {
  kind: string;
  [key: string]: unknown;
}

/** 出站元素（`send-elements.ts` 的 `SendElement`）。 */
export interface OutboundElement {
  kind: string;
  [key: string]: unknown;
}

export interface ToSegmentContext {
  /**
   * **本条消息**是否来自群聊。
   *
   * 只拿元素判断不出场景，而 rkey 的 type、appid 都按场景分叉，所以 resolver
   * 必须能拿到它。resolver 自己声明了 `isGroup` 形参时以此为准。
   */
  isGroup: boolean;
  selfId: number;
  /** 图片下载 URL（入站 `pic` 只有 fileToken，需要换 rkey 才能拼）。 */
  imageUrlResolver?: (element: InboundElement, isGroup: boolean) => Promise<string> | string;
  /** 语音 / 视频 / 文件的下载 URL。 */
  mediaUrlResolver?: (element: InboundElement, isGroup: boolean) => Promise<string> | string;
}

export interface FromSegmentContext {
  /** `at` 段只给 qq 时，用它换 uid（发送侧更可靠）。 */
  resolveMentionUid?: (uin: number) => Promise<string | null> | string | null;
}

export interface ElementCodec {
  /** 收 · 转：入站元素 → OneBot segment。 */
  toSegment?: (element: InboundElement, ctx: ToSegmentContext) => Promise<JsonObject> | JsonObject;
  /** 发 · 解：OneBot segment data → 出站元素。 */
  fromSegment?: (
    data: Record<string, unknown>,
    ctx: FromSegmentContext,
  ) => Promise<OutboundElement | null> | OutboundElement | null;
}

/** 数字字段宽松解析：字符串数字也收，非法值抛错（不要静默变 0）。 */
export function intOr(value: unknown, fallback = 0): number {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new Error(`段字段必须是安全整数，收到 ${String(value)}`);
}

function str(value: unknown, fallback = ''): string {
  return value === undefined || value === null ? fallback : String(value);
}

/** base64 / data URI 这类内联媒体，不该再拼 URL。 */
export function isInlineMediaSource(value: string): boolean {
  return /^(base64:\/\/|data:)/i.test(value);
}

/**
 * 从 `file` / `url` / `path` / `media` 里挑一个真正能加载的源。
 *
 * `file` 常被下游当规范字段回传，但它也可能是 QQ 内部 id（如 `<md5>.png`），
 * 本进程 stat 不到。这时如果同时给了 http(s) `url`，优先用它。
 */
export function pickMediaSource(data: Record<string, unknown>): string {
  const file = str(data.file).trim();
  const url = str(data.url).trim();
  const fallback = file || url || str(data.path).trim() || str(data.media).trim();
  if (!file) return fallback;
  if (isInlineMediaSource(file) || /^(https?:\/\/|file:\/\/)/i.test(file) || /[\\/]/.test(file)) {
    return file;
  }
  if (/^https?:\/\//i.test(url)) return url;
  return fallback;
}

/** base64 媒体源转 bytes（发送路径要用）。 */
export function decodeInlineMedia(value: string): Uint8Array | undefined {
  const match = /^(?:base64:\/\/|data:[^,]*;base64,)(.+)$/i.exec(value.trim());
  if (!match) return undefined;
  return new Uint8Array(Buffer.from(match[1]!, 'base64'));
}

export const ELEMENT_CODECS: Record<string, ElementCodec> = {
  // ─── 文本 ───────────────────────────────────────────────────────────────
  text: {
    toSegment: (element) => ({ type: 'text', data: { text: str(element.textContent) } }),
    fromSegment: (data) => {
      const text = str(data.text);
      return text ? { kind: 'text', textContent: text } : null;
    },
  },

  // ─── @ ──────────────────────────────────────────────────────────────────
  at: {
    toSegment: (element) => {
      const all = element.all === true || str(element.atTargetUid) === 'all';
      const qq = all ? 'all' : str(element.atTargetUin ?? element.atTargetUid);
      return { type: 'at', data: { qq } };
    },
    fromSegment: async (data, ctx) => {
      const qq = str(data.qq).trim();
      if (qq === 'all') return { kind: 'at', all: true, textContent: '@全体成员 ' };
      const uin = intOr(qq, 0);
      if (uin <= 0) return null;

      let uid = str(data.uid).trim();
      if (!uid && ctx.resolveMentionUid) uid = (await ctx.resolveMentionUid(uin)) ?? '';
      const name = str(data.name ?? data.nickname ?? data.card).trim();

      return {
        kind: 'at',
        atTargetUin: uin,
        ...(uid ? { atTargetUid: uid } : {}),
        ...(name ? { textContent: `@${name} ` } : {}),
      };
    },
  },

  // ─── 系统表情 ───────────────────────────────────────────────────────────
  face: {
    toSegment: (element) => ({
      type: 'face',
      data: {
        id: String(element.faceId ?? 0),
        ...(element.innerId !== undefined ? { resultId: str(element.innerId) } : {}),
      },
    }),
    fromSegment: (data) => {
      const id = intOr(data.id, -1);
      if (id < 0) return null;
      const element: OutboundElement = { kind: 'face', faceId: id };
      if (data.resultId !== undefined) {
        element.superSticker = {
          packId: '',
          stickerId: '',
          resultId: str(data.resultId),
        };
      }
      return element;
    },
  },

  // ─── 商城表情 ───────────────────────────────────────────────────────────
  mface: {
    toSegment: (element) => {
      // 统一成 image 段：不认识 mface 的客户端也能显示贴纸，认识的回传 emoji_id
      // 就能原样再发（与 NapCat 行为一致）。
      const raw = element.marketEmoticonId;
      const emojiId =
        typeof raw === 'string'
          ? raw
          : raw instanceof Uint8Array
            ? Buffer.from(raw).toString('hex')
            : '';
      const dir = emojiId.slice(0, 2);
      return {
        type: 'image',
        data: {
          file: emojiId ? `${dir}-${emojiId}.gif` : '',
          url: emojiId
            ? `https://gxh.vip.qq.com/club/item/parcel/item/${dir}/${emojiId}/raw300.gif`
            : '',
          summary: str(element.faceName),
          sub_type: 0,
          emoji_id: emojiId,
          emoji_package_id: intOr(element.emojiPackId),
          key: str(element.encryptKey),
        },
      };
    },
    fromSegment: (data) => {
      const emojiId = str(data.emoji_id).trim();
      if (!emojiId) return null;
      return {
        kind: 'mface',
        marketEmoticonId: emojiId,
        emojiPackId: intOr(data.emoji_package_id ?? data.tab_id),
        ...(data.key ? { encryptKey: str(data.key) } : {}),
        ...(data.summary ? { faceName: str(data.summary) } : {}),
      };
    },
  },

  // ─── 表情弹射 ───────────────────────────────────────────────────────────
  emojiBounce: {
    toSegment: (element) => ({
      type: 'emoji_bounce',
      data: {
        face_id: intOr(element.emojiBounceId),
        count: intOr(/弹射了(\d+)个/.exec(str(element.emojiBounceTextSummary))?.[1], 1),
        name: str(element.emojiBounceName),
      },
    }),
    fromSegment: (data) => {
      const faceId = intOr(data.face_id ?? data.id, -1);
      if (faceId < 0) return null;
      return {
        kind: 'emojiBounce',
        faceId,
        ...(data.count !== undefined ? { count: intOr(data.count, 1) } : {}),
        ...(data.name !== undefined ? { name: str(data.name) } : {}),
      };
    },
  },

  // ─── 引用回复 ───────────────────────────────────────────────────────────
  reply: {
    toSegment: (element) => ({
      type: 'reply',
      data: { id: String(element.origMsgSeq ?? 0) },
    }),
    fromSegment: (data) => {
      const seq = intOr(data.id ?? data.seq, 0);
      if (seq <= 0) return null;
      return { kind: 'reply', origMsgSeq: seq };
    },
  },

  // ─── 图片 ───────────────────────────────────────────────────────────────
  pic: {
    toSegment: async (element, ctx) => {
      const url = ctx.imageUrlResolver ? await ctx.imageUrlResolver(element, ctx.isGroup) : '';
      const md5 =
        element.md5Bytes instanceof Uint8Array ? Buffer.from(element.md5Bytes).toString('hex') : '';
      return {
        type: 'image',
        data: {
          file: str(element.fileName) || (md5 ? `${md5.toLowerCase()}.png` : ''),
          url,
          sub_type: intOr(element.subType),
          summary: str(element.summary),
        },
      };
    },
    // 出站图片：`file` / `url` 都可能给；媒体上传上下文由调用方补。
    fromSegment: (data) => {
      const emojiId = str(data.emoji_id).trim();
      if (emojiId) {
        // 回传的商城表情：按 mface 还原，别当普通图片重传。
        return ELEMENT_CODECS.mface!.fromSegment!(data, {} as FromSegmentContext);
      }
      const source = pickMediaSource(data);
      if (!source) return null;
      const inline = decodeInlineMedia(source);
      return {
        kind: 'image',
        ...(inline ? { pic: { data: inline } } : { source }),
        subType: intOr(data.sub_type ?? data.subType),
        summary: data.summary ? str(data.summary) : undefined,
      };
    },
  },

  // ─── 闪照（仅私聊） ──────────────────────────────────────────────────────
  flashPhoto: {
    fromSegment: (data) => {
      const source = pickMediaSource(data);
      if (!source) return null;
      const inline = decodeInlineMedia(source);
      return { kind: 'flashPhoto', source: inline ?? source };
    },
  },

  // ─── 语音 ───────────────────────────────────────────────────────────────
  ptt: {
    toSegment: async (element, ctx) => {
      const url = ctx.mediaUrlResolver ? await ctx.mediaUrlResolver(element, ctx.isGroup) : '';
      return {
        type: 'record',
        data: { file: str(element.fileName), url },
      };
    },
    fromSegment: (data) => {
      const source = pickMediaSource(data);
      if (!source) return null;
      const inline = decodeInlineMedia(source);
      return { kind: 'record', ...(inline ? { ptt: { data: inline } } : { source }) };
    },
  },

  // ─── 视频 ───────────────────────────────────────────────────────────────
  video: {
    toSegment: async (element, ctx) => {
      const url = ctx.mediaUrlResolver ? await ctx.mediaUrlResolver(element, ctx.isGroup) : '';
      return {
        type: 'video',
        data: { file: str(element.fileName), url },
      };
    },
    fromSegment: (data) => {
      const source = pickMediaSource(data);
      if (!source) return null;
      const inline = decodeInlineMedia(source);
      return {
        kind: 'video',
        ...(inline ? { video: { data: inline } } : { source }),
        ...(data.thumb ? { thumbUrl: str(data.thumb) } : {}),
      };
    },
  },

  // ─── 泡泡消息（短视频） ──────────────────────────────────────────────────
  bubbleVideo: {
    fromSegment: (data) => {
      const source = pickMediaSource(data);
      if (!source) return null;
      const inline = decodeInlineMedia(source);
      return {
        kind: 'bubbleVideo',
        source: inline ?? source,
        ...(data.thumb ? { thumb: str(data.thumb) } : {}),
        ...(data.duration !== undefined ? { duration: intOr(data.duration) } : {}),
        ...(data.width !== undefined ? { width: intOr(data.width) } : {}),
        ...(data.height !== undefined ? { height: intOr(data.height) } : {}),
        ...(data.template_name ? { templateName: str(data.template_name) } : {}),
      };
    },
  },

  // ─── 卡片 ───────────────────────────────────────────────────────────────
  ark: {
    toSegment: (element) => ({ type: 'json', data: { data: str(element.arkData) } }),
    fromSegment: (data) => {
      const raw = data.data;
      const text =
        typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? JSON.stringify(raw) : raw;
      if (typeof text !== 'string' || !text.trim()) {
        throw new Error('json 段的 data 必须是 JSON 对象或非空 JSON 字符串');
      }
      return { kind: 'ark', arkData: text };
    },
  },

  xml: {
    toSegment: (element) => ({
      type: 'xml',
      data: { data: str(element.xmlData ?? element.data), resid: intOr(element.subType, 35) },
    }),
    fromSegment: (data) => ({
      kind: 'xml',
      xmlData: str(data.data),
      subType: intOr(data.resid ?? data.id, 0),
    }),
  },

  markdown: {
    toSegment: (element) => ({ type: 'markdown', data: { content: str(element.content) } }),
    fromSegment: (data) => ({ kind: 'markdown', content: str(data.content) }),
  },

  // ─── 文件 / 合并转发 ────────────────────────────────────────────────────
  file: {
    toSegment: async (element, ctx) => {
      const url = ctx.mediaUrlResolver ? await ctx.mediaUrlResolver(element, ctx.isGroup) : '';
      return {
        type: 'file',
        data: {
          file: str(element.fileName),
          file_id: str(element.fileUuid),
          file_size: intOr(element.fileSize),
          url,
        },
      };
    },
    fromSegment: (data) => {
      const fileId = str(data.file_id ?? data.id).trim();
      const source = pickMediaSource(data);
      if (!fileId && !source) return null;
      const inline = source ? decodeInlineMedia(source) : undefined;
      return {
        kind: 'file',
        ...(fileId ? { fileUuid: fileId } : {}),
        ...(inline ? { file: { data: inline } } : source ? { source } : {}),
        ...(data.file ? { fileName: str(data.file) } : {}),
      };
    },
  },

  forward: {
    toSegment: (element) => ({ type: 'forward', data: { id: str(element.resId) } }),
    fromSegment: (data) => ({
      kind: 'forward',
      resId: str(data.id ?? data.res_id ?? data.forward_id),
    }),
  },

  // ─── 戳一戳（独立 action，不是消息元素；这里只做事件侧映射） ─────────────
  poke: {
    toSegment: (element) => ({ type: 'poke', data: { type: intOr(element.subType) } }),
  },
};

/**
 * segment type → codec 键。
 *
 * 入站元素的 `kind` 与 OneBot 的 segment `type` **不是同一套词**：
 *   - 图片：协议侧叫 `pic`，OneBot 叫 `image`
 *   - 语音：协议侧叫 `ptt`，OneBot 叫 `record`
 *   - 商城表情：协议侧叫 `mface`，OneBot 发出时是 `image`（带 emoji_id）
 * 其余同名。`CELEMENT_CODECS` 的键用**入站 kind**（因为 `toSegment` 按它查），
 * 这张表把出站方向（`fromSegment`）的 segment type 也接进来。
 */
const SEGMENT_TYPE_TO_KIND: Record<string, string> = {
  text: 'text',
  at: 'at',
  face: 'face',
  image: 'pic',
  record: 'ptt',
  video: 'video',
  json: 'ark',
  xml: 'xml',
  markdown: 'markdown',
  file: 'file',
  forward: 'forward',
  poke: 'poke',
  mface: 'mface',
  flash_photo: 'flashPhoto',
  emoji_bounce: 'emojiBounce',
  bubble_video: 'bubbleVideo',
};

/** 按入站元素 kind 查 codec（`toSegment` 方向）。 */
export function getElementCodec(kind: string): ElementCodec | undefined {
  return Object.hasOwn(ELEMENT_CODECS, kind) ? ELEMENT_CODECS[kind] : undefined;
}

/** 按 OneBot segment type 查 codec（`fromSegment` 方向）。 */
export function getSegmentCodec(type: string): ElementCodec | undefined {
  const kind = SEGMENT_TYPE_TO_KIND[type] ?? type;
  return getElementCodec(kind);
}

/** 入站元素 → segment；未建模的 kind 返回 `null`（由调用方决定是否丢弃）。 */
export async function elementToSegment(
  element: InboundElement,
  ctx: ToSegmentContext,
): Promise<JsonObject | null> {
  const codec = getElementCodec(element.kind);
  if (!codec?.toSegment) return null;
  return codec.toSegment(element, ctx);
}

/** OneBot segment 数组 → 协议出站元素数组（发送前最后一步）。 */
export async function segmentsToElements(
  segments: readonly Segment[],
  ctx: FromSegmentContext = {},
): Promise<OutboundElement[]> {
  const out: OutboundElement[] = [];
  for (const segment of segments) {
    const codec = getSegmentCodec(segment.type);
    if (!codec?.fromSegment) {
      throw new Error(`不支持发送的 segment 类型：${segment.type}`);
    }
    const element = await codec.fromSegment(segment.data, ctx);
    if (element) out.push(element);
  }
  return out;
}

/** 入站元素数组 → segment 数组。 */
export async function elementsToSegments(
  elements: readonly InboundElement[],
  ctx: ToSegmentContext,
): Promise<JsonObject[]> {
  const out: JsonObject[] = [];
  for (const element of elements) {
    const segment = await elementToSegment(element, ctx);
    if (segment) out.push(segment);
  }
  return out;
}
