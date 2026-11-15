/**
 * QQ 收藏列表（微云 collector.fcg）。
 *
 * 只做**读取**：WeQ 与 SnowLuma 都没有可用的收藏删除 / 新建网络接口。
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

const ENDPOINT = 'https://collector.weiyun.com/collector.fcg';
const HOST = 'collector.weiyun.com';
const OPERATION_ID = 20_000;
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
  transport?: CollectionTransport;
}

export interface CollectionHttpRequest {
  url: string;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
  timeoutMs: number;
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
    signal: AbortSignal.timeout(request.timeoutMs),
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
  const uin = positiveUin(params.uin);
  if (!params.pskey) throw new Error('collection p_skey is empty');
  const category = validCategory(params.category ?? 0);
  const count = positiveCount(params.count ?? PAGE_SIZE);
  const targetMatchCount = category === 0 ? count : count + 1;
  const transport = params.transport ?? defaultTransport;
  const headers = {
    'Content-Type': 'application/octet-stream',
    Cookie: `uin=${params.uin};vt=${TICKET_TYPE};vi=${params.pskey};appid=${APP_ID}`,
    Host: HOST,
    Range: 'bytes=0-',
  } as const;

  const matched: CollectionItem[] = [];
  const seen = new Set<string>();
  let sequence = 1;
  let timeStamp = INITIAL_TIMESTAMP;
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

    const bytes = await transport({
      url: ENDPOINT,
      headers,
      body: requestBytes(uin, params.pskey, sequence, timeStamp),
      timeoutMs: Math.min(REQUEST_TIMEOUT_MS, remaining),
    });
    const { head, body } = decodeEnvelope(bytes);
    const retCode = typeof head.retCode === 'number' ? head.retCode : 0;
    if (retCode !== 0) {
      throw new Error(
        `collection service error ${retCode}: ${str(head.retMsg) || str(head.promptMsg) || 'unknown error'}`,
      );
    }
    errMsg = str(head.retMsg);

    const operation = body.operation as Record<string, unknown> | undefined;
    const page = operation?.getCollectionList as Record<string, unknown> | undefined;
    if (!page) throw new Error('collection response is missing operation 20000');

    const wireItems = (page.items as Record<string, unknown>[] | undefined) ?? [];
    serverHasMore = num(page.reachedBottom) === 0;
    let nextTimeStamp: bigint | null = null;

    for (const wireItem of wireItems) {
      const cid = str(wireItem.cid);
      if (!cid) throw new Error('collection item is missing cid');
      if (!wireItem.author) throw new Error(`collection item ${cid} is missing author`);
      const modifyTime =
        typeof wireItem.modifyTime === 'bigint'
          ? wireItem.modifyTime
          : BigInt(typeof wireItem.modifyTime === 'number' ? wireItem.modifyTime : 0);
      if (modifyTime <= 0n) throw new Error(`collection item ${cid} is missing modifyTime`);
      if (nextTimeStamp === null || modifyTime < nextTimeStamp) nextTimeStamp = modifyTime;

      const item = mapItem(wireItem);
      const identity = `cid:${item.cid}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      if (category === 0 || item.category === category) matched.push(item);
    }

    if (matched.length >= targetMatchCount || !serverHasMore) break;
    if (wireItems.length === 0 || nextTimeStamp === null || nextTimeStamp === 0n) {
      throw new Error('collection pagination made no progress while more data was reported');
    }
    if (nextTimeStamp >= timeStamp) {
      throw new Error(`collection pagination cursor did not decrease: ${nextTimeStamp}`);
    }
    timeStamp = nextTimeStamp;
    sequence += 1;
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
