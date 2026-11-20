/**
 * QQ 收藏（微云 collector.fcg）。
 *
 * 三个操作字：
 *
 * - `20000` 列表（摘要）：`getCollectionList` 一次拉够 N 条，`getCollectionPage` 按
 *   游标一页一页取（宿主分页 UI / 断点续拉用这个）；
 * - `20001` 全文：`getCollectionDetails`，一次最多 20 个 cid；
 * - `20014` 附件原文件下载申请：见 `collection-download.ts`。
 *
 * 没有可用的收藏删除 / 新建网络接口（WeQ 与 SnowLuma 都没有），所以这里只有读。
 *
 * 报文体是固定 16 字节信封 + head/body 两段 protobuf，分页游标是严格递减的
 * `modifyTime`，底部标记来自 `reachedBottom`（1 / 215000 都视为到底）。
 *
 * 凭据：`weiyun.com` 的 p_skey 放在 head.f11，HTTP Cookie 只带 collector 专用四段。
 */

import { decode, encode } from '../protobuf';
import {
  COLLECTION_REQ_BODY,
  COLLECTION_REQ_HEAD,
  COLLECTION_RESP_BODY,
  COLLECTION_RESP_HEAD,
} from './collection-schemas';
import { WebRequestError } from './http';

const ENDPOINT = 'https://collector.weiyun.com/collector.fcg';
const HOST = 'collector.weiyun.com';
const OPERATION_ID = 20_000;
const CONTENT_OPERATION_ID = 20_001;
const TICKET_TYPE = 27;
const APP_ID = 5_004;
const PAGE_SIZE = 50;
const MAX_PAGES = 100;
const MAX_COUNT = 500;
const REQUEST_TIMEOUT_MS = 10_000;
const OPERATION_TIMEOUT_MS = 60_000;
const CLIENT_VERSION = 0x6105f5e164fn;
const INITIAL_TIMESTAMP = 0xffff_ffff_ffff_ffffn;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/** 详情一次最多 20 个 cid（服务端限制，超过会整批失败）。 */
const MAX_DETAIL_CIDS = 20;
const MAGIC = Uint8Array.from([0x20, 0x13, 0x03, 0x29]);
const VERSION = Uint8Array.from([0x00, 0x01]);

export interface CollectionAuthor {
  type: number;
  numId: string;
  strId: string;
  groupId: string;
  groupName: string;
  uid: string;
}

export interface CollectionItem {
  cid: string;
  type: number;
  status: number;
  author: CollectionAuthor;
  bid: number;
  category: number;
  createTime: string;
  collectTime: string;
  modifyTime: string;
  sequence: string;
  shareUrl: string;
  customGroupId: number;
  securityBeat: boolean;
  summary: {
    textSummary: { text: string; truncated: boolean } | null;
    linkSummary: unknown;
    gallerySummary: unknown;
    audioSummary: unknown;
    videoSummary: unknown;
    fileSummary: unknown;
    locationSummary: unknown;
    richMediaSummary: unknown;
  };
}

export interface CollectionListResult {
  errCode: 0;
  errMsg: string;
  collectionSearchList: {
    collectionItemList: CollectionItem[];
    hasMore: boolean;
    bottomTimeStamp: string;
  };
}

export interface CollectionListParams {
  uin: string;
  pskey: string;
  category?: number;
  count?: number;
  transport?: CollectionTransport | undefined;
}

export interface CollectionHttpRequest {
  url: string;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
  timeoutMs: number;
  /**
   * 取消信号（可选）。
   *
   * **加在 request 上而不是只在调用方**：默认实现要把「调用方取消」与「超时」
   * 合成一个 signal 交给 `fetch`，否则取消只能等到超时。现有的自定义 transport
   * 可以不看它（它们可以只用 `timeoutMs`）。
   */
  signal?: AbortSignal | undefined;
}

export type CollectionTransport = (request: CollectionHttpRequest) => Promise<Uint8Array>;

function positiveUin(value: string): bigint {
  if (!/^[1-9]\d*$/.test(value)) throw new Error('collection uin must be a positive integer');
  const uin = BigInt(value);
  if (uin > INITIAL_TIMESTAMP) throw new Error('collection uin exceeds uint64 range');
  return uin;
}

function positiveCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_COUNT) {
    throw new Error(`collection count must be between 1 and ${MAX_COUNT}`);
  }
  return value;
}

function validCategory(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('collection category must be a non-negative safe integer');
  }
  return value;
}

export function encodeCollectionEnvelope(head: Uint8Array, body: Uint8Array): Uint8Array {
  const total = 16 + head.length + body.length;
  const out = Buffer.allocUnsafe(total);
  out.set(MAGIC, 0);
  out.set(VERSION, 4);
  out.writeUInt32BE(total, 6);
  out.writeUInt32BE(body.length, 10);
  out.writeUInt16BE(0, 14);
  out.set(head, 16);
  out.set(body, 16 + head.length);
  return out;
}

function decodeEnvelope(bytes: Uint8Array): {
  head: Record<string, unknown>;
  body: Record<string, unknown>;
} {
  const input = Buffer.from(bytes);
  if (input.length <= 16) throw new Error('collection response is too short');
  if (!input.subarray(0, 4).equals(Buffer.from(MAGIC))) {
    throw new Error('collection response has invalid magic');
  }
  if (!input.subarray(4, 6).equals(Buffer.from(VERSION))) {
    throw new Error('collection response has unsupported version');
  }
  const total = input.readUInt32BE(6);
  if (total !== input.length) {
    throw new Error(`collection response length mismatch: ${total} != ${input.length}`);
  }
  const bodyLength = input.readUInt32BE(10);
  if (input.readUInt16BE(14) !== 0) {
    throw new Error('collection response has invalid reserved bytes');
  }
  if (bodyLength === 0 || bodyLength >= total - 16) {
    throw new Error('collection response has invalid body length');
  }
  const bodyOffset = total - bodyLength;
  return {
    head: decode(COLLECTION_RESP_HEAD, input.subarray(16, bodyOffset)),
    body: decode(COLLECTION_RESP_BODY, input.subarray(bodyOffset)),
  };
}

function jsonSafe(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value)) out[key] = jsonSafe(field);
    return out;
  }
  throw new Error(`collection response contains unsupported value type: ${typeof value}`);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function int64(value: unknown): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '0';
}

function mapItem(raw: Record<string, unknown>): CollectionItem {
  const author = (raw.author ?? {}) as Record<string, unknown>;
  const summary = (raw.summary ?? {}) as Record<string, unknown>;
  const text = summary.textSummary as Record<string, unknown> | undefined;
  const rich = summary.richMediaSummary as Record<string, unknown> | undefined;
  return {
    cid: str(raw.cid),
    type: num(raw.type),
    status: num(raw.status),
    author: {
      type: num(author.type),
      numId: int64(author.numId),
      strId: str(author.strId),
      groupId: int64(author.groupId),
      groupName: str(author.groupName),
      uid: str(author.uid),
    },
    bid: num(raw.bid),
    category: num(raw.category),
    createTime: int64(raw.createTime),
    collectTime: int64(raw.collectTime),
    modifyTime: int64(raw.modifyTime),
    sequence: int64(raw.sequence),
    shareUrl: str(raw.shareUrl),
    customGroupId: num(raw.customGroupId),
    securityBeat: raw.securityBeat === true,
    summary: {
      textSummary: text ? { text: str(text.text), truncated: text.truncated === true } : null,
      linkSummary: jsonSafe(summary.linkSummary),
      gallerySummary: jsonSafe(summary.gallerySummary),
      audioSummary: jsonSafe(summary.audioSummary),
      videoSummary: jsonSafe(summary.videoSummary),
      fileSummary: jsonSafe(summary.fileSummary),
      locationSummary: jsonSafe(summary.locationSummary),
      richMediaSummary: rich
        ? {
            title: str(rich.title),
            subTitle: str(rich.subTitle),
            brief: str(rich.brief),
            picList: jsonSafe(rich.picList ?? []),
            contentType: num(rich.contentType),
            originalUri: str(rich.originalUri),
            publisher: str(rich.publisher),
            richMediaVersion: num(rich.richMediaVersion),
          }
        : null,
    },
  };
}

function requestBytes(uin: bigint, pskey: string, sequence: number, timeStamp: bigint): Uint8Array {
  const head = encode(COLLECTION_REQ_HEAD, {
    uin,
    sequence,
    commandType: 1,
    operationId: OPERATION_ID,
    clientVersion: CLIENT_VERSION,
    platform: 4,
    ticketType: TICKET_TYPE,
    ticket: pskey,
    field14: 8,
    field15: 9,
  });
  const body = encode(COLLECTION_REQ_BODY, {
    operation: {
      getCollectionList: {
        timeStamp,
        orderType: 2,
        count: PAGE_SIZE,
        searchDown: 1,
      },
    },
  });
  return encodeCollectionEnvelope(head, body);
}

async function defaultTransport(request: CollectionHttpRequest): Promise<Uint8Array> {
  const response = await fetch(request.url, {
    method: 'POST',
    headers: request.headers,
    body: Buffer.from(request.body),
    // `AbortSignal.any`：调用方取消与超时任一触发都要中断。只用 timeout 的话，
    // 页面切走 / 用户点取消还得等满 10 秒。
    signal: request.signal
      ? AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs)])
      : AbortSignal.timeout(request.timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`collection HTTP request failed: ${response.status} ${response.statusText}`);
  }
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    await response.body?.cancel();
    throw new Error('collection response has invalid or oversized content-length');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_RESPONSE_BYTES) {
    throw new Error(`collection response exceeds ${MAX_RESPONSE_BYTES} bytes`);
  }
  return bytes;
}

/** 拉取收藏列表；`category=0` 表示全部分类，`count` 是返回条数上限。 */
export async function getCollectionList(
  params: CollectionListParams,
): Promise<CollectionListResult> {
  const category = validCategory(params.category ?? 0);
  const count = positiveCount(params.count ?? PAGE_SIZE);
  const targetMatchCount = category === 0 ? count : count + 1;

  const matched: CollectionItem[] = [];
  const seen = new Set<string>();
  let cursor: CollectionNetworkCursor | null = null;
  let serverHasMore = true;
  let errMsg = '';
  let pages = 0;
  const deadline = Date.now() + OPERATION_TIMEOUT_MS;

  while (matched.length < targetMatchCount && serverHasMore) {
    if (pages >= MAX_PAGES) throw new Error(`collection pagination exceeded ${MAX_PAGES} pages`);
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`collection pagination exceeded ${OPERATION_TIMEOUT_MS}ms`);
    }
    pages += 1;

    const page = await readCollectionPage({
      uin: params.uin,
      pskey: params.pskey,
      cursor,
      transport: params.transport,
      timeoutMs: Math.min(REQUEST_TIMEOUT_MS, remaining),
    });
    errMsg = page.errMsg;
    serverHasMore = page.hasMore;
    cursor = page.nextCursor;

    for (const wireItem of page.items) {
      const cid = str(wireItem.cid);
      if (!wireItem.author) throw new Error(`collection item ${cid} is missing author`);
      if (typeof wireItem.modifyTime !== 'bigint' || wireItem.modifyTime <= 0n) {
        throw new Error(`collection item ${cid} is missing modifyTime`);
      }
      const item = mapItem(wireItem);
      const identity = `cid:${item.cid}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      if (category === 0 || item.category === category) matched.push(item);
    }
  }

  const collectionItemList = matched.slice(0, count);
  let bottom = 0n;
  for (const item of collectionItemList) {
    const itemTime = BigInt(item.modifyTime);
    if (bottom === 0n || itemTime < bottom) bottom = itemTime;
  }

  return {
    errCode: 0,
    errMsg,
    collectionSearchList: {
      collectionItemList,
      hasMore: category === 0 ? serverHasMore || matched.length > count : matched.length > count,
      bottomTimeStamp: bottom.toString(),
    },
  };
}

// ──────────────────────── 分页 / 全文 / 低层 POST ────────────────────────

/** 分页游标：可序列化、可断点续拉（时间戳严格递减 + 序号递增）。 */
export interface CollectionNetworkCursor {
  timeStamp: string;
  sequence: number;
}

export interface CollectionPageParams {
  uin: string;
  pskey: string;
  cursor?: CollectionNetworkCursor | null;
  transport?: CollectionTransport | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  /** 解码前交出来的原始响应（归档未知字段 / 真机回放）。 */
  onRawResponse?: (capture: {
    sequence: number;
    requestTimeStamp: string;
    response: Uint8Array;
  }) => void | Promise<void>;
}

export interface CollectionCursorPage {
  items: CollectionItem[];
  hasMore: boolean;
  /** 到底时为 null。 */
  nextCursor: CollectionNetworkCursor | null;
  /** 服务端报的条目总数；拿不到或不完整都不能当「已经拉完」的证据。 */
  totalCount: number | null;
  /** 本次响应的完整信封（诊断 / 归档）。 */
  rawResponse: Uint8Array;
  errMsg: string;
}

/** 收藏图片描述（网络层字段；md5 / sha1 保留原始字节）。 */
export interface CollectionPicture {
  url: string;
  md5: Uint8Array | null;
  sha1: Uint8Array | null;
  name: string;
  note: string;
  width: number;
  height: number;
  size: number;
  type: number;
  picId: string;
}

/** 收藏文件描述（uid / size 是 uint64，保留 bigint 以免精度丢失）。 */
export interface CollectionFile {
  src: number;
  uid: bigint;
  bid: number;
  fid: string;
  name: string;
  size: bigint;
  md5: Uint8Array | null;
  sha1: Uint8Array | null;
  category: number;
  ntUid: string;
}

export interface CollectionTextContent {
  data: string;
  hasEmoji: boolean;
}

export interface CollectionAudioContent {
  /** 完整 SILK 流（直接存盘 / 交给音频解码），不是嵌套 protobuf。 */
  data: Uint8Array | null;
}

export interface CollectionRichMediaContent {
  richMedia: Uint8Array | null;
  rawData: Uint8Array | null;
  bizDataList: Uint8Array[];
  picList: CollectionPicture[];
  fileList: CollectionFile[];
}

/**
 * 全文内容（operation 20001）。
 *
 * `link` / `gallery` / `video` / `file` / `location` 在线上就是**原始字节**，
 * 这里原样交出去（与 native / WeQ 的 db 存储一致）；不替下游解第二层。
 */
export interface CollectionContent {
  textContent: CollectionTextContent | null;
  linkContent: Uint8Array | null;
  galleryContent: Uint8Array | null;
  audioContent: CollectionAudioContent | null;
  videoContent: Uint8Array | null;
  fileContent: Uint8Array | null;
  locationContent: Uint8Array | null;
  richMediaContent: CollectionRichMediaContent | null;
}

export interface CollectionDetail {
  cid: string;
  content: CollectionContent;
}

export interface CollectionDetailParams {
  uin: string;
  pskey: string;
  /** 1..20 个 cid；空 / 重复 / 控制字符会直接报错（服务端会整批失败）。 */
  cids: readonly string[];
  transport?: CollectionTransport | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  onRawResponse?: (capture: {
    cids: readonly string[];
    response: Uint8Array;
  }) => void | Promise<void>;
}

export interface PostCollectorParams {
  uin: string;
  pskey: string;
  /** 已拼好的信封（见 `encodeCollectionEnvelope`）。 */
  body: Uint8Array;
  transport?: CollectionTransport | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

function assertPskey(pskey: string): void {
  if (!pskey || /[\r\n;]/.test(pskey)) {
    throw new Error('collection p_skey is empty or invalid (weiyun.com)');
  }
}

/** 控制字符会破坏 collector 的头部 / 文件名，入口就拒掉。 */
function hasControl(value: string, spaces = false): boolean {
  return [...value].some(
    (char) => char.charCodeAt(0) <= (spaces ? 32 : 31) || char.charCodeAt(0) === 127,
  );
}

function bytesOf(value: unknown): Uint8Array | null {
  return value instanceof Uint8Array ? value : null;
}

function mapPicture(raw: Record<string, unknown>): CollectionPicture {
  return {
    url: str(raw.url),
    md5: bytesOf(raw.md5),
    sha1: bytesOf(raw.sha1),
    name: str(raw.name),
    note: str(raw.note),
    width: num(raw.width),
    height: num(raw.height),
    size: num(raw.size),
    type: num(raw.type),
    picId: str(raw.picId),
  };
}

function mapFileInfo(raw: Record<string, unknown>): CollectionFile {
  return {
    src: num(raw.src),
    uid: typeof raw.uid === 'bigint' ? raw.uid : 0n,
    bid: num(raw.bid),
    fid: str(raw.fid),
    name: str(raw.name),
    size: typeof raw.size === 'bigint' ? raw.size : 0n,
    md5: bytesOf(raw.md5),
    sha1: bytesOf(raw.sha1),
    category: num(raw.category),
    ntUid: str(raw.ntUid),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function mapContent(raw: Record<string, unknown>): CollectionContent {
  const text = asRecord(raw.textContent);
  const audio = asRecord(raw.audioContent);
  const rich = asRecord(raw.richMediaContent);
  return {
    textContent: text ? { data: str(text.data), hasEmoji: text.hasEmoji === true } : null,
    linkContent: bytesOf(raw.linkContent),
    galleryContent: bytesOf(raw.galleryContent),
    audioContent: audio ? { data: bytesOf(audio.data) } : null,
    videoContent: bytesOf(raw.videoContent),
    fileContent: bytesOf(raw.fileContent),
    locationContent: bytesOf(raw.locationContent),
    richMediaContent: rich
      ? {
          richMedia: bytesOf(rich.richMedia),
          rawData: bytesOf(rich.rawData),
          bizDataList: Array.isArray(rich.bizDataList)
            ? rich.bizDataList.map(bytesOf).filter((value): value is Uint8Array => value !== null)
            : [],
          picList: Array.isArray(rich.picList)
            ? rich.picList.map((value) => mapPicture(asRecord(value) ?? {}))
            : [],
          fileList: Array.isArray(rich.fileList)
            ? rich.fileList.map((value) => mapFileInfo(asRecord(value) ?? {}))
            : [],
        }
      : null,
  };
}

function detailRequestBytes(uin: bigint, pskey: string, cids: readonly string[]): Uint8Array {
  const head = encode(COLLECTION_REQ_HEAD, {
    uin,
    sequence: 1,
    commandType: 1,
    operationId: CONTENT_OPERATION_ID,
    clientVersion: CLIENT_VERSION,
    platform: 4,
    ticketType: TICKET_TYPE,
    ticket: pskey,
    field14: 8,
    field15: 9,
  });
  const body = encode(COLLECTION_REQ_BODY, {
    operation: { getCollectionContent: { cidList: [...cids] } },
  });
  return encodeCollectionEnvelope(head, body);
}

/**
 * 一次带超时与取消的 collector POST。
 *
 * 超时与取消是**可区分**的错误：宿主把前者当「重试」、后者当「用户放弃了」，
 * 混成一句「网络错误」会让重试按钮在用户主动取消后再跑一遍。
 */
export async function postCollector(params: PostCollectorParams): Promise<Uint8Array> {
  const timeoutMs = params.timeoutMs ?? REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('collection timeout must be a positive integer');
  }
  params.signal?.throwIfAborted();

  const controller = new AbortController();
  const abortFromCaller = (): void => controller.abort(params.signal?.reason);
  params.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new Error(`collection request timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  let rejectOnAbort: (() => void) | undefined;
  try {
    const request: CollectionHttpRequest = {
      url: ENDPOINT,
      headers: {
        'Content-Type': 'application/octet-stream',
        Cookie: `uin=${params.uin};vt=${TICKET_TYPE};vi=${params.pskey};appid=${APP_ID}`,
        Host: HOST,
        Range: 'bytes=0-',
      },
      body: params.body,
      timeoutMs,
      signal: controller.signal,
    };
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectOnAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
    });
    const transport = params.transport ?? defaultTransport;
    const response = await Promise.race([transport(request), aborted]);
    controller.signal.throwIfAborted();
    if (response.length > MAX_RESPONSE_BYTES) {
      throw new Error('collection response exceeds size limit');
    }
    return response;
  } catch (cause) {
    if (controller.signal.aborted) {
      if (params.signal?.aborted) {
        throw new WebRequestError('cancelled', '收藏请求已取消。', { cause: params.signal.reason });
      }
      throw new WebRequestError('timeout', `collection request timed out after ${timeoutMs}ms`, {
        cause,
      });
    }
    throw cause;
  } finally {
    clearTimeout(timer);
    if (rejectOnAbort) controller.signal.removeEventListener('abort', rejectOnAbort);
    params.signal?.removeEventListener('abort', abortFromCaller);
  }
}

/**
 * 拉**一页**收藏（带可续拉的游标）。
 *
 * 与 {@link getCollectionList} 的分工：那个是「一次拉到 N 条」的便利函数（OneBot
 * 的 `get_collection_list` 用它）；这个把分页控制权交给宿主，供分页 UI / 断点续拉 /
 * 增量同步使用。
 */
export async function getCollectionPage(
  params: CollectionPageParams,
): Promise<CollectionCursorPage> {
  const page = await readCollectionPage(params);
  return { ...page, items: page.items.map(mapItem) };
}

/** 读取一页线上的条目，保留 bigint、字段缺失及原始信封供宿主映射。 */
export async function readCollectionPage(
  params: CollectionPageParams,
): Promise<Omit<CollectionCursorPage, 'items'> & { items: Record<string, unknown>[] }> {
  const uin = positiveUin(params.uin);
  assertPskey(params.pskey);

  const timeStampText = params.cursor?.timeStamp ?? INITIAL_TIMESTAMP.toString();
  if (!/^\d+$/.test(timeStampText)) throw new Error('collection cursor timestamp is invalid');
  const timeStamp = BigInt(timeStampText);
  if (timeStamp <= 0n || timeStamp > INITIAL_TIMESTAMP) {
    throw new Error('collection cursor timestamp exceeds uint64');
  }
  const sequence = params.cursor?.sequence ?? 1;
  if (!Number.isSafeInteger(sequence) || sequence <= 0 || sequence >= 0xffff_ffff) {
    throw new Error('collection cursor sequence is invalid');
  }

  const bytes = await postCollector({
    uin: params.uin,
    pskey: params.pskey,
    body: requestBytes(uin, params.pskey, sequence, timeStamp),
    transport: params.transport,
    signal: params.signal,
    timeoutMs: params.timeoutMs,
  });
  await params.onRawResponse?.({
    sequence,
    requestTimeStamp: timeStamp.toString(),
    response: bytes,
  });

  const { head, body } = decodeEnvelope(bytes);
  const retCode = typeof head.retCode === 'number' ? head.retCode : 0;
  if (retCode !== 0) {
    throw new Error(
      `collection service error ${retCode}: ${str(head.retMsg) || str(head.promptMsg) || 'unknown error'}`,
    );
  }
  const page = asRecord(asRecord(body.operation)?.getCollectionList);
  if (!page) throw new Error('collection response is missing operation 20000');

  const reachedBottom = typeof page.reachedBottom === 'number' ? page.reachedBottom : 0;
  if (![0, 1, 215000].includes(reachedBottom)) {
    throw new Error('collection response has an invalid reachedBottom flag');
  }
  // 真机最后一页回 215000（还剩 20 条），旧 / 合成响应用 1：两者都算到底。
  const hasMore = reachedBottom !== 1 && reachedBottom !== 215000;

  const wireItems = Array.isArray(page.items) ? (page.items as Record<string, unknown>[]) : [];
  const seen = new Set<string>();
  const items: Record<string, unknown>[] = [];
  let nextTimeStamp: bigint | null = null;
  for (const wireItem of wireItems) {
    const cid = str(wireItem.cid);
    if (!cid) throw new Error('collection response contains an item with no cid');
    const modifyTime = typeof wireItem.modifyTime === 'bigint' ? wireItem.modifyTime : 0n;
    if (nextTimeStamp === null || modifyTime < nextTimeStamp) nextTimeStamp = modifyTime;
    if (seen.has(cid)) continue;
    seen.add(cid);
    items.push(wireItem);
  }

  // 报了还有更多，但游标没往前走 → 继续拉只会死循环，宁可报错也不要卡住宿主。
  if (hasMore && (nextTimeStamp === null || nextTimeStamp <= 0n || nextTimeStamp >= timeStamp)) {
    throw new Error('collection pagination made no progress while more data was reported');
  }

  return {
    items,
    hasMore,
    nextCursor: hasMore
      ? { timeStamp: (nextTimeStamp as bigint).toString(), sequence: sequence + 1 }
      : null,
    totalCount: typeof page.totalCount === 'number' ? page.totalCount : null,
    rawResponse: bytes,
    errMsg: str(head.retMsg),
  };
}

/**
 * 批量取收藏全文（operation 20001），一次 1..20 个 cid。
 *
 * 顺序与入参一一对应（服务端按请求顺序回），数量不匹配直接报错 —— 对不上号
 * 时静默返回一半结果，调用方会把内容存到错误的 cid 上。
 */
export async function getCollectionDetails(
  params: CollectionDetailParams,
): Promise<CollectionDetail[]> {
  const details = await readCollectionDetails(params);
  return details.map(({ cid, content }) => ({ cid, content: mapContent(content) }));
}

/** 读取并按请求顺序关联原始详情，留给宿主转换为各自的缓存模型。 */
export async function readCollectionDetails(
  params: CollectionDetailParams,
): Promise<Array<{ cid: string; content: Record<string, unknown> }>> {
  const uin = positiveUin(params.uin);
  assertPskey(params.pskey);

  if (params.cids.length < 1 || params.cids.length > MAX_DETAIL_CIDS) {
    throw new Error(`collection detail batch must contain 1-${MAX_DETAIL_CIDS} ids`);
  }
  const unique = new Set<string>();
  for (const cid of params.cids) {
    if (!cid || cid.length > 256 || hasControl(cid)) {
      throw new Error('collection detail cid is invalid');
    }
    if (unique.has(cid)) throw new Error('collection detail batch contains duplicate ids');
    unique.add(cid);
  }

  const bytes = await postCollector({
    uin: params.uin,
    pskey: params.pskey,
    body: detailRequestBytes(uin, params.pskey, params.cids),
    transport: params.transport,
    signal: params.signal,
    timeoutMs: params.timeoutMs,
  });
  await params.onRawResponse?.({ cids: params.cids, response: bytes });

  const { head, body } = decodeEnvelope(bytes);
  const retCode = typeof head.retCode === 'number' ? head.retCode : 0;
  if (retCode !== 0) {
    throw new Error(
      `collection service error ${retCode}: ${str(head.retMsg) || str(head.promptMsg) || 'unknown error'}`,
    );
  }
  const operation = asRecord(asRecord(body.operation)?.getCollectionContent);
  if (!operation) throw new Error('collection response is missing operation 20001');
  const contents = Array.isArray(operation.contents)
    ? (operation.contents as Record<string, unknown>[])
    : [];
  if (contents.length !== params.cids.length) {
    throw new Error(
      `collection detail count mismatch: ${contents.length} != ${params.cids.length}`,
    );
  }
  return contents.map((raw, index) => ({
    cid: params.cids[index]!,
    content: raw,
  }));
}
