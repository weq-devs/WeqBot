import { parse, parseFragment, type DefaultTreeAdapterMap } from 'parse5';
import { computeBkn, type WebCredential } from './credential';
import { parseJsLiteral, parseQzoneCallback } from './qzone';
import {
  qqWebUrl,
  qzoneMarkupText,
  qzoneReadRequest,
  readQzoneData,
  unsigned,
  type QzoneReadResponse,
} from './qzone_more';

const GATEWAY = 'https://user.qzone.qq.com/p/h5/pc/api/sns.qzone.qq.com/cgi-bin/qzshare/';
const LIST = 'cgi_qzsharegetmylistbytype';
export const QZONE_SHARE_CATEGORIES = [0, 1, 2, 3, 4, 5, 10, 13, 17, 18] as const;
export type QzoneShareCategory = (typeof QZONE_SHARE_CATEGORIES)[number];

export interface QzoneShare {
  id: string;
  category: number | null;
  memo: string;
  publishedAt: string;
  publishedTime: number | null;
  title: string;
  originalUrl: string;
  previewUrl: string;
}

type Element = DefaultTreeAdapterMap['element'];
type Node = DefaultTreeAdapterMap['node'];
const attribute = (node: Element | undefined, name: string) =>
  node?.attrs.find((attr) => attr.name === name)?.value ?? '';
const hasClass = (node: Element, name: string) =>
  attribute(node, 'class').split(/\s+/).includes(name);

function elements(root: Node): Element[] {
  const result: Element[] = [];
  const stack: Node[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if ('tagName' in node) result.push(node);
    if ('childNodes' in node) stack.push(...node.childNodes.slice().reverse());
  }
  return result;
}

function scriptText(node: Element): string {
  return node.childNodes.map((child) => ('value' in child ? child.value : '')).join('');
}

function shareInfo(nodes: Element[], id: string) {
  for (const script of nodes.filter((node) => node.tagName === 'script')) {
    const source = scriptText(script);
    const body = source.match(/^\s*shareInfos\.push\(\s*(\{[\s\S]*\})\s*\)\s*;?\s*$/)?.[1];
    if (!body) continue;
    try {
      const info = parseJsLiteral(body) as { id?: number | string; type?: unknown; memo?: unknown };
      if (String(info?.id) === id) return info;
    } catch {
      // 只投影已知的数据字面量。HTML 中可见的附言仍然可读。
    }
  }
  return null;
}

function originalLink(value: string) {
  if (!value.startsWith('mqqapi://microapp/open?')) return qqWebUrl(value);
  return qqWebUrl(new URL(value).searchParams.get('fakeUrl') || '') || value;
}

// 同时保留 QQ 显示的时间。只有分享 ID 转成的北京时间能与显示时间核对上，才输出绝对时间。
function publishedTimestamp(id: string, label: string, now: number): number | null {
  if (!/^\d{10}$/.test(id)) return null;
  const timestamp = Number(id);
  const offset = 8 * 60 * 60 * 1000;
  const local = new Date(timestamp * 1000 + offset).toISOString();
  const [year, month, day] = local.slice(0, 10).split('-');
  const time = local.slice(11, 16);
  const dateLabels = [
    `${year}-${month}-${day}`,
    `${year}年${month}月${day}日`,
    `${month}月${day}日`,
  ];
  const relative = ['今天', '昨天', '前天'].find(
    (_, days) =>
      new Date(now + offset - days * 86_400_000).toISOString().slice(0, 10) === local.slice(0, 10),
  );
  if (relative) dateLabels.push(relative);
  return dateLabels.some((date) => `${date} ${time}` === label.replace(/\s+/g, ' '))
    ? timestamp
    : null;
}

export function parseQzoneShares(html: string, hostUin: string, page: number, now = Date.now()) {
  const all = elements(parse(html));
  const root = all.find((node) => attribute(node, 'id') === 'shares');
  if (!root) {
    const empty = all.some(
      (node) => node.tagName === 'p' && qzoneMarkupText(node).trim() === '0条分享',
    );
    if (empty && all.some((node) => attribute(node, 'id') === 'shareForm'))
      return { items: [] as QzoneShare[], next: null };
    throw new Error('QQ 空间未返回可读取的分享列表。');
  }
  const items = elements(root)
    .filter((node) => node.tagName === 'li' && attribute(node, 'id').startsWith('share_'))
    .map((node): QzoneShare => {
      const key = attribute(node, 'id');
      const [, owner, id] = key.match(/^share_(\d+)_(\d{1,32})$/) ?? [];
      if (!id || owner !== hostUin) throw new Error('QQ 空间分享的主人或编号与请求不匹配。');
      const nodes = elements(node);
      const info = shareInfo(nodes, id);
      const title = nodes.find((entry) => hasClass(entry, '_share_title'));
      const detail = nodes.find((entry) => hasClass(entry, 'mod_details'));
      const description = nodes.find((entry) => hasClass(entry, '_share_desc_cont'));
      const scraps = nodes.find((entry) => hasClass(entry, 'mod_scraps'));
      const time = scraps && elements(scraps).find((entry) => hasClass(entry, 'mgrl'));
      const memo = description && elements(description).find((entry) => hasClass(entry, 'c_tx2'));
      const image = detail && elements(detail).find((entry) => entry.tagName === 'img');
      const publishedAt = time ? qzoneMarkupText(time).trim() : '';
      return {
        id,
        category: unsigned(info?.type),
        memo: typeof info?.memo === 'string' ? info.memo : memo ? qzoneMarkupText(memo).trim() : '',
        publishedAt,
        publishedTime: publishedTimestamp(id, publishedAt, now),
        title: title ? qzoneMarkupText(title).trim() : '',
        originalUrl: originalLink(attribute(title, 'href')),
        previewUrl: qqWebUrl(attribute(image, 'src')),
      };
    });
  if (!items.length) throw new Error('QQ 空间分享列表缺少分享条目。');
  for (const script of all.filter((node) => node.tagName === 'script')) {
    const pagination = scriptText(script).match(
      /^\s*var totalPage\s*=\s*(\d+)\s*;\s*var currentPage\s*=\s*(\d+)\s*;\s*$/,
    );
    if (!pagination) continue;
    const total = unsigned(pagination[1]);
    if (!total || total < page || unsigned(pagination[2]) !== page)
      throw new Error('QQ 空间分享的返回页与请求不匹配。');
    return { items, next: page < total ? page + 1 : null };
  }
  // 官方的翻页链接含模板空白。只读取数字，不向服务端提供的地址发请求。
  const next = all.some((node) => {
    if (node.tagName !== 'a') return false;
    const href = attribute(node, 'href').replace(/\s/g, '');
    if (!href.startsWith(`${LIST}?`)) return false;
    const query = new URLSearchParams(href.slice(LIST.length + 1));
    return query.get('uin') === hostUin && unsigned(query.get('page')) === page + 1;
  })
    ? page + 1
    : null;
  return { items, next };
}

export async function getQzoneShares(
  cred: WebCredential,
  hostUin: string,
  category: QzoneShareCategory,
  page: number,
  signal?: AbortSignal,
) {
  const raw = await qzoneReadRequest(
    cred,
    hostUin,
    `${GATEWAY}${LIST}`,
    {
      uin: hostUin,
      spaceuin: hostUin,
      g_iframeUser: cred.uin,
      page: String(page),
      num: '10',
      isfriend: '0',
      ttype: String(category),
    },
    signal,
  );
  return parseQzoneShares(raw, hostUin, page);
}

const COMMENTS_PER_PAGE = 3;

type ShareComment = {
  CommentID?: number | string;
  AuthorUin?: number | string;
  Author?: string;
  Content?: string;
  Time?: string;
  items2?: ShareComment[];
};

function decodeShareComment(row: ShareComment) {
  const id = String(row.CommentID ?? '');
  if (!/^\d+$/.test(id)) throw new Error('QQ 空间分享评论缺少编号。');
  const uin = String(row.AuthorUin ?? '');
  return {
    id,
    uin: /^[1-9]\d{4,19}$/.test(uin) ? uin : '',
    nickname: qzoneMarkupText(parseFragment(row.Author || '')).trim(),
    text: qzoneMarkupText(parseFragment(row.Content || '')).trim(),
    publishedAt: row.Time || '',
  };
}

export function parseQzoneShareComments(text: string, page: number) {
  const data = readQzoneData(
    parseQzoneCallback<QzoneReadResponse<{ total?: unknown; items?: ShareComment[] }>>(text),
    '分享评论',
  );
  const total = unsigned(data.total);
  if (total === null || (!Array.isArray(data.items) && !(data.items == null && total === 0)))
    throw new Error('QQ 空间分享评论响应无效。');
  const items = (data.items ?? []).map((row) => ({
    ...decodeShareComment(row),
    replies: (row.items2 ?? []).map(decodeShareComment),
  }));
  if (!items.length && total > (page - 1) * COMMENTS_PER_PAGE)
    throw new Error('QQ 空间仍有分享评论，本页暂未返回内容。');
  return { items, total, next: page * COMMENTS_PER_PAGE < total ? page + 1 : null };
}

export async function getQzoneShareComments(
  cred: WebCredential,
  hostUin: string,
  shareId: string,
  page: number,
  signal?: AbortSignal,
) {
  const raw = await qzoneReadRequest(
    cred,
    hostUin,
    `${GATEWAY}cgi_qzshareget_comment`,
    {
      uin: hostUin,
      itemid: shareId,
      commnum: String(COMMENTS_PER_PAGE),
      commpage: String(page),
      fupdate: '1',
      notice: '1',
      platform: 'qzone',
      token: String(computeBkn(cred.pskey || cred.skey)),
    },
    signal,
  );
  return parseQzoneShareComments(raw, page);
}
