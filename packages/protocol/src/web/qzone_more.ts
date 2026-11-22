import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';
import { computeBkn, cookieHeader, WebAuthError, type WebCredential } from './credential';
import { WEB_READ_RETRY, webRequestText } from './http';
import { parseQzoneCallback } from './qzone';

export const QZONE_PROXY = 'https://h5.qzone.qq.com/proxy/domain/';

export function qzoneReadRequest(
  cred: WebCredential,
  hostUin: string,
  endpoint: string,
  query: Record<string, string>,
  signal?: AbortSignal,
) {
  const url = new URL(endpoint);
  url.search = new URLSearchParams({
    g_tk: String(computeBkn(cred.pskey || cred.skey)),
    ...query,
  }).toString();
  return webRequestText(url.href, {
    cookie: cookieHeader(cred),
    headers: { Referer: `https://user.qzone.qq.com/${hostUin}` },
    redirect: 'error',
    retry: WEB_READ_RETRY,
    maxResponseBytes: 2 * 1024 * 1024,
    signal,
  });
}

export type QzoneReadResponse<T> = {
  code?: number;
  subcode?: number;
  message?: string;
  error?: { type?: number; msg?: string };
  data?: T;
};

export function readQzoneData<T>(result: QzoneReadResponse<T>, label: string): T {
  const code = result.error?.type ?? result.code;
  if (code === -3 || code === -3000 || code === -10000)
    throw new WebAuthError('QQ 空间登录态失效，请重新登录。', code);
  if (code !== 0 || (result.subcode ?? 0) !== 0 || !result.data)
    throw new Error(`读取${label}失败，请重试。`);
  return result.data;
}

export function unsigned(value: unknown): number | null {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export function qqWebUrl(value: string): string {
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    return url.href;
  } catch {
    return '';
  }
}

export function qzoneMarkupText(node: DefaultTreeAdapterMap['node'], depth = 0): string {
  if (depth > 64) return '';
  if ('value' in node) return node.value;
  if ('tagName' in node) {
    if (['script', 'style', 'iframe', 'object', 'template'].includes(node.tagName)) return '';
    if (node.tagName === 'br') return '\n';
    if (node.tagName === 'img') {
      const src = node.attrs.find(({ name }) => name === 'src')?.value;
      const emoji = src?.match(/\/qzone\/em\/(e\d+)\.(?:gif|png)(?:[?#]|$)/i)?.[1];
      return emoji
        ? `[em]${emoji}[/em]`
        : node.attrs.find(({ name }) => name === 'alt')?.value || '[图片]';
    }
  }
  if (!('childNodes' in node)) return '';
  const text = node.childNodes.map((child) => qzoneMarkupText(child, depth + 1)).join('');
  return 'tagName' in node && ['div', 'p', 'li'].includes(node.tagName) ? `${text}\n` : text;
}

type VisitorData = {
  totalpage?: unknown;
  totalcount?: unknown;
  todaycount?: unknown;
  modvisitcount?: { mod?: unknown; totalcount?: unknown; todaycount?: unknown }[];
  items?: { uin?: string | number; name?: string; time?: unknown; mod?: unknown }[];
};

export function parseQzoneVisitors(text: string, page: number) {
  const response = parseQzoneCallback<QzoneReadResponse<VisitorData>>(text);
  const noAccess =
    (response.error?.type ?? response.code) !== 0 &&
    ((response.code === -99996 && response.subcode === -4009) ||
      /无权(?:限)?(?:查看|访问)|没有权限|无访问权限|拒绝访问|访问受限/.test(
        response.error?.msg || response.message || '',
      ));
  if (noAccess) {
    return {
      status: 'forbidden' as const,
      totalCount: null,
      todayCount: null,
      items: [],
      next: null,
    };
  }
  const data = readQzoneData(response, '空间访客');
  const all = Array.isArray(data.modvisitcount)
    ? data.modvisitcount.find((row) => row.mod === 0 || row.mod === '0')
    : undefined;
  const totalCount = unsigned(all?.totalcount) ?? unsigned(data.totalcount);
  const todayCount = unsigned(all?.todaycount) ?? unsigned(data.todaycount);
  if (data.items != null && !Array.isArray(data.items)) throw new Error('空间访客列表响应无效。');
  const items = (data.items ?? []).flatMap((row) => {
    const uin = String(row.uin ?? '');
    const time = unsigned(row.time);
    return /^[1-9]\d{4,19}$/.test(uin) && time
      ? [{ id: `${uin}:${time}:${row.mod ?? 0}`, uin, nickname: row.name || uin, time }]
      : [];
  });
  const totalPages = unsigned(data.totalpage);
  const status =
    items.length || totalCount === 0 || data.items?.length === 0 ? 'ok' : 'unavailable';
  return {
    status,
    totalCount,
    todayCount,
    items,
    next: items.length && totalPages !== null && page < totalPages ? page + 1 : null,
  } as const;
}

export async function getQzoneVisitors(
  cred: WebCredential,
  hostUin: string,
  page: number,
  signal?: AbortSignal,
) {
  const raw = await qzoneReadRequest(
    cred,
    hostUin,
    `${QZONE_PROXY}g.qzone.qq.com/cgi-bin/friendshow/cgi_get_visitor_simple`,
    { uin: hostUin, mask: '2', page: String(page), fupdate: '1' },
    signal,
  );
  return parseQzoneVisitors(raw, page);
}

type GuestbookData = {
  total?: unknown;
  authorInfo?: { msg?: string; htmlMsg?: string };
  commentList?: {
    id: string | number;
    uin: string | number;
    nickname?: string;
    pubtime?: string;
    htmlContent?: string;
    ubbContent?: string;
    replyList?: { uin: string | number; nick?: string; time?: unknown; content?: string }[];
  }[];
};

function boardContent(html: string | undefined, plain = '') {
  return html ? qzoneMarkupText(parseFragment(html)).trim() || plain : plain;
}

export function parseQzoneGuestbook(text: string, offset: number) {
  const data = readQzoneData(parseQzoneCallback<QzoneReadResponse<GuestbookData>>(text), '留言板');
  const total = unsigned(data.total);
  if (
    total === null ||
    (!Array.isArray(data.commentList) && !(data.commentList == null && offset >= total))
  )
    throw new Error('QQ 空间留言板分页响应无效。');
  const rows = data.commentList ?? [];
  if (!rows.length && offset < total) throw new Error('QQ 空间仍有留言，本页暂未返回内容。');
  const items = rows.map((row) => {
    if (unsigned(row.id) === null) throw new Error('QQ 空间留言缺少编号。');
    return {
      id: String(row.id),
      uin: String(row.uin ?? ''),
      nickname: row.nickname || '',
      publishedAt: row.pubtime || '',
      text: boardContent(row.htmlContent, row.ubbContent),
      replies: (row.replyList ?? []).map((reply, index) => ({
        id: `${row.id}:${index}`,
        uin: String(reply.uin ?? ''),
        nickname: reply.nick || '',
        time: unsigned(reply.time),
        text: boardContent(reply.content),
      })),
    };
  });
  return {
    greeting: boardContent(data.authorInfo?.htmlMsg, data.authorInfo?.msg),
    total,
    items,
    next: offset + rows.length < total ? offset + rows.length : null,
  };
}

export async function getQzoneGuestbook(
  cred: WebCredential,
  hostUin: string,
  offset: number,
  signal?: AbortSignal,
) {
  const raw = await qzoneReadRequest(
    cred,
    hostUin,
    `${QZONE_PROXY}m.qzone.qq.com/cgi-bin/new/get_msgb`,
    {
      uin: cred.uin,
      hostUin,
      start: String(offset),
      num: '10',
      format: 'jsonp',
      hostword: offset === 0 ? '1' : '0',
      essence: '1',
      inCharset: 'utf-8',
      outCharset: 'utf-8',
    },
    signal,
  );
  return parseQzoneGuestbook(raw, offset);
}

type VideoData = {
  Videos?: {
    vid?: string;
    title?: string;
    desc?: string;
    shuoshuoid?: unknown;
    url?: string;
    pre?: string;
    duration?: unknown;
    uploadTime?: unknown;
  }[];
  isLast?: unknown;
  nextPageStart?: unknown;
};

export function parseQzoneVideos(text: string, start: number) {
  const data = readQzoneData(parseQzoneCallback<QzoneReadResponse<VideoData>>(text), '空间视频');
  const last = data.isLast === true || data.isLast === 'true';
  if (!Array.isArray(data.Videos) && !(data.Videos == null && last))
    throw new Error('QQ 空间视频列表响应无效。');
  const next = last ? null : unsigned(data.nextPageStart);
  if (!last && (next === null || next <= start)) throw new Error('QQ 空间视频分页未推进。');
  const items = new Map<
    string,
    {
      id: string;
      videoId: string;
      videoUrl: string;
      coverUrl: string;
      duration: number;
      uploadedAt: number | null;
      title: string;
      description: string;
      sourcePostId: string | null;
    }
  >();
  for (const row of data.Videos ?? []) {
    const id = row.vid;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(id))
      throw new Error('QQ 空间视频缺少媒体编号。');
    if (items.has(id)) continue;
    items.set(id, {
      id,
      videoId: id,
      videoUrl: qqWebUrl(row.url || ''),
      coverUrl: qqWebUrl(row.pre || ''),
      duration: unsigned(row.duration) ?? 0,
      uploadedAt: unsigned(row.uploadTime),
      title: row.title || '',
      description: row.desc || '',
      sourcePostId:
        typeof row.shuoshuoid === 'string' && /^[a-f\d]{24}$/i.test(row.shuoshuoid)
          ? row.shuoshuoid.toLowerCase()
          : null,
    });
  }
  return { items: [...items.values()], next };
}

export async function getQzoneVideos(
  cred: WebCredential,
  hostUin: string,
  start: number,
  signal?: AbortSignal,
) {
  const raw = await qzoneReadRequest(
    cred,
    hostUin,
    `${QZONE_PROXY}taotao.qq.com/cgi-bin/video_get_data`,
    {
      uin: cred.uin,
      hostUin,
      appid: '4',
      getMethod: '2',
      start: String(start),
      count: '20',
      need_old: start === 0 ? '1' : '0',
      format: 'jsonp',
    },
    signal,
  );
  return parseQzoneVideos(raw, start);
}
