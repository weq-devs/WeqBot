/**
 * 收藏附件「原文件」下载申请（collector.fcg operation 20014）。
 *
 * 收藏里的文件 / 视频，列表只给描述符（`fid` / `md5` / `size` …）。要拿到真正的
 * 下载地址，得用手里的描述符换一次：返回的 `key` 拼进 `/ftn_handler/<hex>/`，
 * 外加一个**只对这一个文件有效**的 cookie。
 *
 * 三条硬约束（都是真机踩出来的）：
 *
 * 1. 头的字段与列表**不是一套**：`version` 是 collector 自己的头版本
 *    （`0x5f5e1642`）、`client` 是 `0x610`。拿列表的头去请求会被判「版本不支持」；
 * 2. QQ 构建变化可能导致服务端返回内容不匹配的地址。调用方下载后须按
 *    收藏声明的大小和 MD5 确认原件；申请成功只表示得到了下载地址；
 * 3. 返回的 `key` 是字节（native 直接 hex 拼进 URL），不是 UTF-8 文本；
 *    地址与 cookie 都是一次性的，不要落盘、不要进日志。
 */

import { decode, encode } from '../protobuf';
import {
  COLLECTION_DOWNLOAD_REQ_BODY,
  COLLECTION_DOWNLOAD_REQ_HEAD,
  COLLECTION_DOWNLOAD_RESP_BODY,
  COLLECTION_DOWNLOAD_RESP_HEAD,
} from './collection-schemas';
import {
  encodeCollectionEnvelope,
  postCollector,
  type CollectionFile,
  type CollectionTransport,
} from './collection';

const DOWNLOAD_OPERATION_ID = 20_014;
/** collector 自己的头版本；与列表的 `CLIENT_VERSION` 不同。 */
const COLLECTOR_HEAD_VERSION = 0x5f5e1642;
const COLLECTOR_CLIENT = 0x610;
const TICKET_TYPE = 27;
const MAX_KEY_BYTES = 4096;
const MAX_NAME_LENGTH = 4096;
const MAX_COOKIE_LENGTH = 8192;
/** 下载 cookie 只允许发往这两个域（**不**含图片域）。 */
const DOWNLOAD_DOMAINS = ['qq.com', 'weiyun.com'];
/** 媒体地址允许的域（比下载 cookie 的宽松，但仍然是 QQ 自己的）。 */
const MEDIA_DOMAINS = ['qq.com', 'qpic.cn', 'gtimg.cn', 'gtimg.com', 'tencent.com', 'weiyun.com'];

export interface CollectionDownloadResource {
  /** 一次性下载地址。 */
  url: string;
  /** 一次性下载 cookie（`name=value`）；不要持久化。 */
  cookie: string;
}

export class CollectionDownloadRejectedError extends Error {
  constructor(
    readonly code: number,
    detail: string,
  ) {
    super(`收藏附件下载申请失败（代码 ${code}）${detail ? `：${detail}` : ''}。`);
  }
}

export interface CollectionDownloadParams {
  uin: string;
  pskey: string;
  cid: string;
  file: CollectionFile;
  /** 当前 QQ 的 `<version>-<build>`，由调用方从运行中的客户端核定。 */
  clientBuild: string;
  transport?: CollectionTransport | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

function hasControl(value: string, spaces = false): boolean {
  return [...value].some(
    (char) => char.charCodeAt(0) <= (spaces ? 32 : 31) || char.charCodeAt(0) === 127,
  );
}

function isDomain(host: string, domains: readonly string[]): boolean {
  const lower = host.toLowerCase();
  return domains.some((domain) => lower === domain || lower.endsWith(`.${domain}`));
}

/** 规范化附件地址：只允许 https + 白名单域，去掉端口 / hash。 */
function attachmentUrl(host: string, keyHex: string, name: string): string {
  const url = new URL(`https://${host}/ftn_handler/${keyHex}/?fname=${encodeURIComponent(name)}`);
  if (!isDomain(url.hostname, MEDIA_DOMAINS))
    throw new Error('收藏附件地址不是受支持的 QQ 资源地址。');
  url.protocol = 'https:';
  url.port = '';
  url.hash = '';
  return url.href;
}

function assertRequest(params: CollectionDownloadParams): void {
  if (!/^\d+(?:\.\d+)+-\d+$/.test(params.clientBuild))
    throw new Error('无法识别当前 QQ 构建，不能申请收藏附件下载。');
  if (!/^[1-9]\d*$/.test(params.uin) || BigInt(params.uin) > 0xffffffffffffffffn) {
    throw new Error('collection uin must be a positive integer');
  }
  if (!params.pskey || /[\r\n;]/.test(params.pskey)) {
    throw new Error('收藏附件下载缺少有效的收藏凭据。');
  }
  const { cid, file } = params;
  if (!cid || cid.length > 256 || hasControl(cid)) throw new Error('收藏附件的来源信息不完整。');
  if (!file.fid || file.fid.length > MAX_NAME_LENGTH || hasControl(file.fid)) {
    throw new Error('收藏附件的来源信息不完整。');
  }
  if (!file.name || file.name.length > MAX_NAME_LENGTH || hasControl(file.name)) {
    throw new Error('收藏附件的来源信息不完整。');
  }
  if (file.md5?.length !== 16) throw new Error('收藏附件的来源信息不完整。');
  if (typeof file.size !== 'bigint' || file.size < 0n || file.size > 0xffffffffffffffffn) {
    throw new Error('收藏附件的来源信息不完整。');
  }
  for (const value of [file.src, file.bid, file.category]) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      throw new Error('收藏附件的来源信息无效。');
    }
  }
  if (file.uid < 0n || file.uid > 0xffffffffffffffffn) {
    throw new Error('收藏附件的来源信息无效。');
  }
  if (file.sha1 && file.sha1.length !== 20) throw new Error('收藏附件的来源信息无效。');
  if (file.ntUid && (file.ntUid.length > 256 || hasControl(file.ntUid))) {
    throw new Error('收藏附件的来源信息无效。');
  }
}

function requestBytes(params: CollectionDownloadParams): Uint8Array {
  const head = encode(COLLECTION_DOWNLOAD_REQ_HEAD, {
    uin: BigInt(params.uin),
    sequence: 1,
    command: 1,
    operation: DOWNLOAD_OPERATION_ID,
    version: COLLECTOR_HEAD_VERSION,
    client: COLLECTOR_CLIENT,
    platform: 4,
    ticketType: TICKET_TYPE,
    ticket: params.pskey,
    field14: 8,
    field15: 9,
  });
  const body = encode(COLLECTION_DOWNLOAD_REQ_BODY, {
    operation: {
      apply: {
        cid: params.cid,
        thumbnail: false,
        file: {
          src: params.file.src,
          uid: params.file.uid,
          bid: params.file.bid,
          fid: params.file.fid,
          name: params.file.name,
          size: params.file.size,
          md5: params.file.md5 ?? new Uint8Array(),
          sha1: params.file.sha1 ?? new Uint8Array(),
          category: params.file.category,
          ntUid: params.file.ntUid,
        },
      },
    },
  });
  return encodeCollectionEnvelope(head, body);
}

/**
 * 换一个收藏附件的原文件下载地址。
 *
 * 返回的 `url` / `cookie` 都是一次性的凭证级信息：调用方应立刻发起下载，**不要**
 * 写进导出包、回执、日志或渲染层状态。
 */
export async function applyCollectionFileDownload(
  params: CollectionDownloadParams,
): Promise<CollectionDownloadResource> {
  params.signal?.throwIfAborted();
  assertRequest(params);

  const bytes = Buffer.from(
    await postCollector({
      uin: params.uin,
      pskey: params.pskey,
      body: requestBytes(params),
      transport: params.transport,
      signal: params.signal,
      timeoutMs: params.timeoutMs,
    }),
  );
  params.signal?.throwIfAborted();

  // 信封自校验：magic + version + 长度。下载这条路一旦错位，后面解出来的
  // 「地址」会是一个能打开的垃圾文件，静默通过比报错危险得多。
  if (
    bytes.length <= 16 ||
    !bytes.subarray(0, 6).equals(Buffer.from([0x20, 0x13, 0x03, 0x29, 0, 1])) ||
    bytes.readUInt32BE(6) !== bytes.length
  ) {
    throw new Error('收藏附件下载申请返回无效响应。');
  }
  const bodySize = bytes.readUInt32BE(10);
  if (bodySize === 0 || bodySize >= bytes.length - 16) {
    throw new Error('收藏附件下载申请返回无效响应。');
  }
  const split = bytes.length - bodySize;
  const headBytes = bytes.subarray(16, split);

  let head: Record<string, unknown>;
  try {
    // 接受完整字段之后的填充，保留字段内部的零字节和空字符串。
    head = decode(COLLECTION_DOWNLOAD_RESP_HEAD, headBytes, {
      strict: true,
      allowTrailingZeroPadding: true,
    });
  } catch (cause) {
    throw new Error('收藏附件下载申请返回无效响应。', { cause });
  }
  const retCode = typeof head.retCode === 'number' ? head.retCode : 0;
  if (retCode !== 0) {
    const detail =
      (typeof head.retMsg === 'string' && head.retMsg) ||
      (typeof head.promptMsg === 'string' && head.promptMsg) ||
      '';
    throw new CollectionDownloadRejectedError(retCode, detail);
  }
  // 头里的身份 / 序号必须与本次请求对得上，否则拿到的可能是别的会的响应。
  if (
    head.uin !== BigInt(params.uin) ||
    head.sequence !== 1 ||
    head.command !== 2 ||
    head.operation !== DOWNLOAD_OPERATION_ID
  ) {
    throw new Error('收藏附件下载响应与当前请求不匹配。');
  }

  const body = decode(COLLECTION_DOWNLOAD_RESP_BODY, bytes.subarray(split));
  const operation = body.operation as Record<string, unknown> | undefined;
  const response = operation?.apply as Record<string, unknown> | undefined;
  const route = response?.route as Record<string, unknown> | undefined;
  const key = response?.key instanceof Uint8Array ? response.key : null;
  const httpsHost = typeof response?.httpsHost === 'string' ? response.httpsHost : '';
  const httpsPort = typeof response?.httpsPort === 'number' ? response.httpsPort : 0;
  const cookieName = typeof response?.cookieName === 'string' ? response.cookieName : '';
  const cookieValue = typeof response?.cookieValue === 'string' ? response.cookieValue : '';

  if (
    route?.type !== 1 ||
    !key ||
    key.length === 0 ||
    key.length > MAX_KEY_BYTES ||
    !httpsHost ||
    httpsPort !== 443 ||
    !/^[a-z0-9.-]+$/i.test(httpsHost) ||
    !cookieName ||
    !/^[!#$%&'*+.^_`|~a-z0-9-]+$/i.test(cookieName) ||
    !cookieValue ||
    hasControl(cookieValue, true) ||
    cookieValue.includes(';') ||
    cookieValue.length > MAX_COOKIE_LENGTH
  ) {
    throw new Error('收藏附件暂未返回可用的安全下载地址。');
  }
  // 一次性 cookie 只能发往 collector 的文件域：图片域 / 重定向都不行。
  if (!isDomain(httpsHost, DOWNLOAD_DOMAINS)) {
    throw new Error('收藏附件下载地址不受支持。');
  }

  return {
    url: attachmentUrl(httpsHost, Buffer.from(key).toString('hex'), params.file.name),
    cookie: `${cookieName}=${cookieValue}`,
  };
}
