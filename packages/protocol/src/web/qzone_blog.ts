import { parse, serialize, type DefaultTreeAdapterMap } from 'parse5';
import { computeBkn, cookieHeader, WebAuthError, type WebCredential } from './credential';
import { WEB_READ_RETRY, webRequestBytes, webRequestText } from './http';
import { parseQzoneJson } from './qzone';

const BLOG_GATEWAY = 'https://user.qzone.qq.com/proxy/domain/b.qzone.qq.com/cgi-bin/blognew/';

export interface QzoneBlogSummary {
  id: string;
  title: string;
  summary: string;
  publishedAt: string;
  images: string[];
  commentCount: number | null;
}

export interface QzoneBlogComment {
  id: string;
  text: string;
  time: number;
  uin: string;
  nickname: string;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function uint(value: unknown): number | null {
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function blogRequest(
  cred: WebCredential,
  hostUin: string,
  path: string,
  params: Record<string, string>,
  signal?: AbortSignal,
) {
  const url = new URL(path, BLOG_GATEWAY);
  url.search = new URLSearchParams({
    ...params,
    ref: 'qzone',
    g_tk: String(computeBkn(cred.pskey || cred.skey)),
  }).toString();
  return {
    url: url.href,
    init: {
      cookie: cookieHeader(cred),
      headers: { Referer: `https://user.qzone.qq.com/${hostUin}` },
      redirect: 'error' as const,
      retry: WEB_READ_RETRY,
      maxResponseBytes: 4 * 1024 * 1024,
      signal,
    },
  };
}

function readData(raw: string, operation: string): Record<string, unknown> {
  const result = parseQzoneJson<{ code?: number; message?: string; data?: unknown }>(raw);
  if (result.code === -3000 || result.code === -10000)
    throw new WebAuthError(result.message || '请重新登录 QQ 空间', result.code);
  if (result.code !== 0) throw new Error(result.message || `${operation}失败`);
  const data = object(result.data);
  if (!data) throw new Error(`${operation}返回缺少内容`);
  return data;
}

function readPage<T>(
  totalValue: unknown,
  list: unknown,
  offset: number,
  decode: (row: unknown) => T,
) {
  const total = uint(totalValue);
  if (total === null || (!Array.isArray(list) && !(list == null && offset >= total)))
    throw new Error('QQ 空间日志分页响应无效');
  const rows = Array.isArray(list) ? list : [];
  if (!rows.length && offset < total) throw new Error('QQ 空间日志尚有内容，但本页为空');
  const items = rows.map(decode);
  const next = offset + rows.length;
  return { items, total, nextOffset: next < total ? next : null };
}

export async function getQzoneBlogs(
  cred: WebCredential,
  hostUin: string,
  offset: number,
  limit: number,
  signal?: AbortSignal,
) {
  const { url, init } = blogRequest(
    cred,
    hostUin,
    'get_abs',
    {
      hostUin,
      uin: cred.uin,
      blogType: '0',
      cateName: '',
      cateHex: '',
      statYear: '',
      reqInfo: '3',
      pos: String(offset),
      num: String(limit),
      sortType: '0',
      absType: '1',
      source: '0',
      verbose: '1',
      format: 'jsonp',
      inCharset: 'utf-8',
      outCharset: 'utf-8',
    },
    signal,
  );
  const data = readData(await webRequestText(url, init), '读取日志列表');
  return readPage(data.totalNum, data.list, offset, (value): QzoneBlogSummary => {
    const row = object(value);
    const id = uint(row?.blogId);
    if (!row || !id) throw new Error('QQ 空间日志列表缺少日志编号');
    return {
      id: String(id),
      title: text(row.title),
      summary: text(row.abstract),
      publishedAt: text(row.pubTime),
      images: Array.isArray(row.img)
        ? row.img.flatMap((image) => {
            const url = text(object(image)?.url);
            return /^(https?:)?\/\//i.test(url)
              ? [url.startsWith('//') ? `https:${url}` : url]
              : [];
          })
        : [],
      commentCount: uint(row.commentNum),
    };
  });
}

function blogBody(document: string): string {
  const pending: DefaultTreeAdapterMap['node'][] = [parse(document)];
  while (pending.length) {
    const node = pending.pop()!;
    if (
      'tagName' in node &&
      node.tagName === 'div' &&
      node.attrs.some(({ name, value }) => name === 'id' && value === 'blogDetailDiv')
    )
      return serialize(node);
    if ('childNodes' in node) for (const child of node.childNodes) pending.push(child);
  }
  throw new Error('QQ 空间未返回可读取的日志正文');
}

export async function getQzoneBlog(
  cred: WebCredential,
  hostUin: string,
  blogId: string,
  signal?: AbortSignal,
) {
  const { url, init } = blogRequest(
    cred,
    hostUin,
    'blog_output_data',
    {
      uin: hostUin,
      blogid: blogId,
      mode: '2',
      numperpage: '50',
      page: '1',
      styledm: 'qzonestyle.gtimg.cn',
      imgdm: 'qzs.qq.com',
      bdm: 'b.qzone.qq.com',
      inCharset: 'gb2312',
      outCharset: 'gb2312',
    },
    signal,
  );
  const document = new TextDecoder('gbk').decode(await webRequestBytes(url, init));
  if (/^\s*(?:\w+\s*\()?\s*\{/.test(document)) readData(document, '读取日志正文');
  return { html: blogBody(document) };
}

export async function getQzoneBlogComments(
  cred: WebCredential,
  hostUin: string,
  blogId: string,
  offset: number,
  limit: number,
  signal?: AbortSignal,
) {
  const { url, init } = blogRequest(
    cred,
    hostUin,
    'get_comment_list',
    {
      uin: cred.uin,
      topicId: `${hostUin}_${blogId}`,
      start: String(offset),
      num: String(limit),
      format: 'jsonp',
      inCharset: 'utf-8',
      outCharset: 'utf-8',
    },
    signal,
  );
  const data = readData(await webRequestText(url, init), '读取日志评论');
  return readPage(data.total, data.comments, offset, (value): QzoneBlogComment => {
    const row = object(value);
    const id = uint(row?.id);
    if (!row || id === null) throw new Error('QQ 空间日志评论缺少编号');
    const poster = object(row.poster);
    return {
      id: String(id),
      text: text(row.content),
      time: uint(row.postTime) ?? 0,
      uin: String(uint(poster?.id) || ''),
      nickname: text(poster?.name),
    };
  });
}
