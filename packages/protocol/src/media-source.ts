/**
 * 媒体来源解析：本地路径 / 内存字节 / **http(s) URL**。
 *
 * 为什么需要这一层：OneBot 客户端发图时最常给的是 `url`（`file` 往往是服务端
 * 文件名，本机 stat 不到）。所有发送路径最终都要「一段字节」或「一个本地文件」，
 * 所以在这里统一把 URL 下载成字节，而不是让每条上传管线各自判断一次。
 *
 * 三条纪律：
 *   1. **不跟随跨域重定向到非 http(s)**：`redirect: 'follow'` 但最终协议不是
 *      http(s) 就拒绝 —— 防止 `file://` 之类被当成媒体源读进来。
 *   2. **有界**：响应上限默认 32 MiB，超了直接断开（与 highway 单块 1 MiB、
 *      NTV2 图片上限同一量级的保守值）；`Content-Length` 先声明超限的不读 body。
 *   3. **不落盘**：下载到的字节只在调用栈里活一次，不建缓存、不写临时文件
 *      （硬约束 13）。
 */

/** 默认单次下载上限。群文件由调用方自己给（可能很大）。 */
export const MAX_MEDIA_DOWNLOAD_BYTES = 32 * 1024 * 1024;

/** 单次下载的默认总时限。 */
export const MEDIA_DOWNLOAD_TIMEOUT_MS = 60_000;

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

export interface FetchMediaBytesOptions {
  /** 响应上限，默认 {@link MAX_MEDIA_DOWNLOAD_BYTES}。 */
  maxBytes?: number;
  /** 总时限，默认 {@link MEDIA_DOWNLOAD_TIMEOUT_MS}。 */
  timeoutMs?: number;
  /** 出错的上下文前缀，例如「图片」。 */
  what?: string;
  /** 测试注入点；默认用全局 `fetch`。 */
  fetchImpl?: typeof fetch;
}

/**
 * 下载一个 http(s) 资源到内存。
 *
 * 失败一律抛错并带上下文，不做「返回空字节继续发」这种降级 —— 发一张空图
 * 比明确报错更难排查。
 */
export async function fetchMediaBytes(
  url: string,
  options: FetchMediaBytesOptions = {},
): Promise<Uint8Array> {
  const what = options.what ?? '媒体';
  const maxBytes = options.maxBytes ?? MAX_MEDIA_DOWNLOAD_BYTES;
  const timeoutMs = options.timeoutMs ?? MEDIA_DOWNLOAD_TIMEOUT_MS;

  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch (cause) {
    throw new Error(`${what} URL 非法：${url}`, { cause });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${what} 只支持 http(s) URL，收到 ${parsed.protocol}`);
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error(`${what} 下载上限无效：${String(maxBytes)}`);
  }

  const signal = AbortSignal.timeout(timeoutMs);
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(parsed, { redirect: 'follow', signal });
  } catch (cause) {
    throw new Error(`${what} 下载失败：${url}`, { cause });
  }

  // `redirect: 'follow'` 允许重定向；落地协议仍必须是 http(s)。
  if (response.url) {
    let finalUrl: URL | undefined;
    try {
      finalUrl = new URL(response.url);
    } catch {
      finalUrl = undefined;
    }
    if (!finalUrl || (finalUrl.protocol !== 'http:' && finalUrl.protocol !== 'https:')) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`${what} 下载被重定向到非 http(s) 地址：${response.url}`);
    }
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`${what} 下载失败：HTTP ${response.status}`);
  }

  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`${what} 超过下载上限（声明 ${declared} > ${maxBytes} 字节）`);
  }

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0) throw new Error(`${what} 下载到空内容：${url}`);
    if (bytes.length > maxBytes) throw new Error(`${what} 超过下载上限（${maxBytes} 字节）`);
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        throw new Error(`${what} 超过下载上限（${maxBytes} 字节）`);
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  if (total === 0) throw new Error(`${what} 下载到空内容：${url}`);
  return Buffer.concat(chunks);
}
