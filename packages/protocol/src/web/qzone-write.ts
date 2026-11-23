/**
 * 空间写操作（P8.5）：改说说权限、回复与转发说说。
 *
 * 搬运自 SnowLuma `protocol/src/web/qzone.ts` 的 `updateQzoneMsgRight` /
 * `replyQzoneComment`，只把凭据参数换成 {@link WebCredential}、
 * 传输换成 `./http`。**写操作不做自动重试**（重放会产生重复回复或重复提交）。
 *
 * 2026-11-16 补齐 `forwardQzoneMsg`：来源 WeQ `account/web/qzone_write_actions.ts`。
 * WeQ 和 OneBot 共用表单请求与 {@link parseQzoneFormReply} 回执校验。
 */

import { computeBkn, cookieHeader, WebAuthError, type WebCredential } from './credential';
import { setTimeout as wait } from 'node:timers/promises';
import { webRequestText } from './http';
import { assertQzoneWriteAccepted, parseQzoneFormReply } from './qzone-form-reply';
import { parseQzoneJson } from './qzone';

import type { QzoneUgcRight } from './qzone_publish';

export interface QzoneReplyTarget {
  /** thread 的顶层评论 id。 */
  commentId: string;
  commentUin: string;
  /** 回复某条子回复时，被 @ 的作者。 */
  replyTo?: { uin: string; name: string };
}

interface RawDetailPic {
  pic_id?: string;
  pictype?: number | string;
  type?: number | string;
  height?: number | string;
  b_height?: number | string;
  width?: number | string;
  b_width?: number | string;
  smallurl?: string;
  url1?: string;
  url2?: string;
  url3?: string;
}

interface RawDetail {
  code?: number;
  subcode?: number;
  message?: string;
  msg?: string;
  tid?: string;
  uin?: number | string;
  content?: string;
  conlist?: Array<{ con?: string; type?: number | string }> | null;
  pic?: RawDetailPic[] | null;
  video?: unknown[] | null;
  voice?: unknown[] | null;
  audio?: unknown[] | null;
  custom_voices?: unknown[] | null;
  custom_audios?: unknown[] | null;
  rt_tid?: number | string;
  rt_uin?: number | string;
  rt_source_url?: string;
  t1_source?: number | string;
  isEditable?: number | string;
  public_pav?: number | string;
  has_more_con?: boolean | number | string;
  richtype?: number | string;
  richval?: string;
  pic_template?: string;
  special_url?: string;
  t1_subtype?: number | string;
  subrichtype?: number | string;
  feedversion?: number | string;
  ver?: number | string;
  ugc_right?: number | string;
  to_sign?: number | string;
  ugcright_id?: string;
  code_version?: number | string;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 拉一条说说的原始详情（改权限要原样回传 pic / richval，不能用展示层映射）。 */
async function fetchRawDetail(
  cred: WebCredential,
  hostUin: string,
  tid: string,
  signal?: AbortSignal,
): Promise<RawDetail> {
  const query = new URLSearchParams({
    tid,
    uin: hostUin,
    t1_source: '1',
    not_trunc_con: '1',
    need_right: '1',
    not_adapt_outpic: '1',
    g_tk: String(computeBkn(cred.pskey || cred.skey)),
  });
  const text = await webRequestText(
    `https://h5.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msgdetail_v6?${query}`,
    {
      cookie: cookieHeader(cred),
      headers: { Referer: `https://user.qzone.qq.com/${hostUin}`, 'Cache-Control': 'no-cache' },
      signal,
    },
  );
  const data = parseQzoneJson<RawDetail>(text);
  const code =
    data.code !== undefined && data.code !== 0 ? data.code : (data.subcode ?? data.code ?? -1);
  if (code !== 0) {
    if (code === -3000 || code === -10000) throw new WebAuthError('说说详情票据已失效。', code);
    throw new Error(`说说详情读取失败：code=${code} ${data.message ?? data.msg ?? ''}`.trim());
  }
  return data;
}

/** 从详情重建整条说说（emotion_cgi_update 不是局部更新）。 */
export function buildQzoneUpdatePayload(detail: RawDetail, selfUin: string): URLSearchParams {
  if (!detail.tid) throw new Error('说说详情缺少 tid');

  const pics = detail.pic ?? [];
  const richtype = detail.richtype !== undefined ? Number(detail.richtype) : pics.length ? 1 : 0;
  const richvals: string[] = [];
  const picBo: string[] = [];

  for (const pic of pics) {
    const picId = String(pic.pic_id ?? '');
    if (!picId) continue;
    const [, albumId, lloc] = picId.split(',');
    if (!albumId || !lloc) throw new Error('说说详情里的图片信息不完整');
    const picType = String(pic.pictype ?? pic.type ?? 22);
    const height = String(pic.height ?? pic.b_height ?? 0);
    const width = String(pic.width ?? pic.b_width ?? 0);
    richvals.push(`,${albumId},${lloc},${lloc},${picType},${height},${width},,0,0`);
    for (const key of ['smallurl', 'url1', 'url2', 'url3'] as const) {
      const url = pic[key];
      if (!url) continue;
      const match = /[?&]bo=([^&#]+)/.exec(url);
      if (match?.[1]) {
        picBo.push(decodeURIComponent(match[1]));
        break;
      }
    }
  }

  if (richtype === 1 && richvals.length === 0) throw new Error('图片说说缺少图片信息');

  const conParts = (detail.conlist ?? [])
    .map((part) => part.con)
    .filter((value): value is string => typeof value === 'string');
  const content = conParts.length ? conParts.join('').trim() : (detail.content ?? '');
  const subrichtype = detail.t1_subtype ?? detail.subrichtype ?? (richvals.length === 0 ? '' : 1);
  const boGroup = picBo.join(',');
  const hostuin = String(detail.uin ?? selfUin);

  return new URLSearchParams({
    syn_tweet_verson: '1',
    tid: String(detail.tid),
    paramstr: '1',
    pic_template: detail.pic_template ?? '',
    richtype: String(richtype),
    richval: richvals.length ? richvals.join('\t') : (detail.richval ?? ''),
    special_url: detail.special_url ?? '',
    subrichtype: String(subrichtype),
    pic_bo: boGroup ? `${boGroup}\t${boGroup}` : '',
    con: content,
    feedversion: String(detail.feedversion ?? 1),
    ver: String(detail.ver ?? 1),
    ugc_right: String(Number(detail.ugc_right ?? 1)),
    to_sign: String(Number(detail.to_sign ?? 0)),
    ugcright_id: String(detail.ugcright_id ?? detail.tid),
    hostuin,
    code_version: String(detail.code_version ?? 1),
    format: 'fs',
    qzreferrer: `https://user.qzone.qq.com/${hostuin}`,
  });
}

function assertRight(ugcRight: number): QzoneUgcRight {
  if ([1, 4, 16, 64, 128].includes(ugcRight)) return ugcRight as QzoneUgcRight;
  throw new Error('ugc_right 只能是 1 / 4 / 16 / 64 / 128');
}

/** 改一条说说（自己的）的可见范围。`targetUins` 用 `|` 连接，仅 16/128 需要。 */
export async function setQzoneMsgRight(
  cred: WebCredential,
  hostUin: string,
  tid: string,
  ugcRight: number,
  targetUins?: string[],
): Promise<{ ugc_right: number }> {
  if (!tid) throw new Error('tid 不能为空');
  const right = assertRight(ugcRight);
  const targets =
    targetUins
      ?.map((uin) => uin.trim())
      .filter(Boolean)
      .join('|') ?? '';
  if ((right === 16 || right === 128) && !targets) {
    throw new Error('ugc_right 为 16 / 128 时必须给 target_uins');
  }

  const detail = await fetchRawDetail(cred, hostUin, tid);
  const body = buildQzoneUpdatePayload(detail, cred.uin);
  body.set('ugc_right', String(right));
  if (targets) body.set('allow_uins', targets);

  const text = await webRequestText(
    `https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_update?g_tk=${computeBkn(cred.pskey || cred.skey)}`,
    {
      method: 'POST',
      cookie: cookieHeader(cred),
      body: body.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    },
  );
  const data = parseQzoneJson<{
    code?: number;
    subcode?: number;
    message?: string;
    ugc_right?: unknown;
  }>(text);
  if (typeof data.subcode === 'number' && data.subcode !== 0) {
    throw new Error(`说说权限修改失败：subcode=${data.subcode} ${data.message ?? ''}`.trim());
  }
  if (typeof data.code === 'number' && data.code !== 0) {
    throw new Error(`说说权限修改失败：code=${data.code} ${data.message ?? ''}`.trim());
  }
  return { ugc_right: Number(data.ugc_right ?? right) };
}

export type QzoneTextVisibility = 1 | 4 | 64;

function editableTextPost(
  detail: RawDetail,
  hostUin: string,
  tid: string,
): { visibility: QzoneTextVisibility; content: string } {
  if (String(detail.uin) !== hostUin || detail.tid !== tid)
    throw new Error('说说身份无法核对，请重新打开。');
  const visibility = Number(detail.ugc_right);
  if (visibility !== 1 && visibility !== 4 && visibility !== 64)
    throw new Error('暂不支持修改这条说说的可见范围。');
  if (
    typeof detail.content !== 'string' ||
    !detail.content.trim() ||
    /@\{|\[em\]|<\/?[a-z][^>]*>/i.test(detail.content) ||
    (detail.conlist?.length &&
      (detail.conlist.some((part) => Number(part?.type) !== 2 || typeof part?.con !== 'string') ||
        detail.conlist.map((part) => part.con).join('') !== detail.content)) ||
    [
      detail.pic,
      detail.video,
      detail.voice,
      detail.audio,
      detail.custom_voices,
      detail.custom_audios,
    ].some((items) => items != null && (!Array.isArray(items) || items.length > 0)) ||
    (detail.richtype !== undefined && Number(detail.richtype) !== 0) ||
    detail.richval ||
    detail.special_url ||
    (detail.rt_tid && detail.rt_tid !== '0') ||
    Number(detail.rt_uin ?? 0) !== 0 ||
    detail.rt_source_url ||
    Number(detail.t1_source) === 2 ||
    Number(detail.t1_subtype) === 33 ||
    Number(detail.isEditable) === 0 ||
    Number(detail.public_pav) === 1 ||
    (detail.has_more_con !== undefined && Number(detail.has_more_con) !== 0)
  )
    throw new Error('当前仅支持修改纯文本说说的可见范围。');
  return { visibility, content: detail.content };
}

export async function getQzoneTextPostVisibility(cred: WebCredential, tid: string) {
  const detail = await fetchRawDetail(cred, cred.uin, tid);
  const { visibility } = editableTextPost(detail, cred.uin, tid);
  return { visibility };
}

/** PC 空间整帖保存。只编辑已验证能从详情原样重建的普通文本。 */
export async function setQzoneTextPostVisibility(
  cred: WebCredential,
  tid: string,
  expected: QzoneTextVisibility,
  visibility: QzoneTextVisibility,
  current: () => void,
): Promise<{ state: 'confirmed' | 'unchanged' | 'unconfirmed'; visibility?: QzoneTextVisibility }> {
  const { uin } = cred;
  const detail = await fetchRawDetail(cred, uin, tid);
  const before = editableTextPost(detail, uin, tid);
  current();
  if (before.visibility === visibility) return { state: 'unchanged', visibility };
  if (before.visibility !== expected) throw new Error('可见范围已变化，请重新打开后再保存。');
  const body = buildQzoneUpdatePayload(detail, uin);
  body.set('richtype', '');
  body.set('subrichtype', '');
  body.delete('pic_bo');
  body.set('con', before.content);
  body.set('to_sign', '0');
  body.set('ugc_right', String(visibility));
  const referrer = `https://user.qzone.qq.com/${uin}/mood/${tid}`;
  body.set('qzreferrer', referrer);
  let writeError: unknown;
  try {
    const text = await webRequestText(
      `https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_update?g_tk=${computeBkn(cred.pskey)}`,
      {
        method: 'POST',
        cookie: cookieHeader(cred),
        body: body.toString(),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: 'https://user.qzone.qq.com',
          Referer: referrer,
        },
      },
    );
    assertQzoneWriteAccepted(parseQzoneFormReply(text), '可见范围修改');
  } catch (error) {
    writeError = error;
  }
  const signal = AbortSignal.timeout(6000);
  for (const delay of [0, 350, 1000]) {
    if (delay) await wait(delay, undefined, { signal }).catch(() => undefined);
    current();
    if (signal.aborted) break;
    const after = await fetchRawDetail(cred, uin, tid, signal).catch(() => null);
    current();
    if (!after || after.tid !== tid || String(after.uin) !== uin) continue;
    if (after.content !== before.content)
      throw new Error('说说正文与保存前不同，请到 QQ 空间核对。');
    if (Number(after.ugc_right) === visibility) return { state: 'confirmed', visibility };
  }
  if (writeError) throw writeError;
  return { state: 'unconfirmed' };
}

/**
 * 回复某条说说下的评论。
 *
 * 回复走单独的 `emotion_cgi_addreply_ugc`；`replyTo` 会被编码成 QQ 的
 * `@{uin:...,nick:...}` 提及（不是 HTML 转义）。
 */
export async function replyQzoneMsg(
  cred: WebCredential,
  hostUin: string,
  tid: string,
  target: QzoneReplyTarget,
  content: string,
): Promise<{ comment_id: string; parent_comment_id: string; parent_comment_uin: number }> {
  for (const [field, value] of Object.entries({
    hostUin,
    commentUin: target.commentUin,
  })) {
    if (!/^[1-9]\d*$/.test(value)) throw new Error(`${field} 必须是正整数`);
  }
  if (!tid.trim() || !content.trim() || !target.commentId.trim()) {
    throw new Error('tid / content / commentId 不能为空');
  }

  let replyContent = content;
  if (target.replyTo) {
    const { uin, name } = target.replyTo;
    if (!/^[1-9]\d*$/.test(uin) || !name.trim()) {
      throw new Error('replyTo 需要正整数 uin 与非空昵称');
    }
    const escaped = name.trim().replace(/%/g, '%25').replace(/,/g, '%2C').replace(/}/g, '%7D');
    replyContent = `@{uin:${uin},nick:${escaped},auto:1} ${content}`;
  }

  const text = await webRequestText(
    `https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_addreply_ugc?g_tk=${computeBkn(cred.pskey || cred.skey)}`,
    {
      method: 'POST',
      cookie: cookieHeader(cred),
      body: new URLSearchParams({
        uin: cred.uin,
        hostUin,
        hostuin: cred.uin,
        topicId: `${hostUin}_${tid}`,
        commentId: target.commentId,
        commentUin: target.commentUin,
        content: replyContent,
        inCharset: 'utf-8',
        outCharset: 'utf-8',
        ref: '',
        code_version: '1',
        format: 'fs',
        qzreferrer: `https://user.qzone.qq.com/${hostUin}`,
      }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    },
  );
  const response = object(parseQzoneJson<unknown>(text));
  if (!response || typeof response.code !== 'number') {
    throw new Error('空间回复响应缺少明确回执，结果未确认，请核对后刷新。');
  }
  const subcode = response.subcode;
  if (typeof subcode === 'number' && subcode !== 0) {
    throw new Error(`空间回复失败：subcode=${subcode} ${String(response.message ?? '')}`.trim());
  }
  if (response.code !== 0) {
    throw new Error(`空间回复失败：code=${response.code} ${String(response.message ?? '')}`.trim());
  }
  const data = object(response.data);
  const id = data?.id;
  if (!((typeof id === 'string' && id.trim()) || (typeof id === 'number' && id >= 0))) {
    throw new Error('空间回复已提交但没有返回合法 id，请核对后刷新。');
  }
  return {
    comment_id: String(id),
    parent_comment_id: target.commentId,
    parent_comment_uin: Number(target.commentUin),
  };
}

// ─────────────── 整条说说转发 — emotion_cgi_forward_v6 ───────────────

const FORM_CGI = 'https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin';
const FORM_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

function assertQzoneIdentity(hostUin: string, tid: string): void {
  if (!/^[1-9]\d{4,19}$/.test(hostUin) || !/^[A-Za-z0-9_-]{1,128}$/.test(tid)) {
    throw new Error('空间动态身份无效。');
  }
}

/**
 * POST 到 taotao 的写 cgi 并解析回执。
 *
 * - 表单纯文本，UA 用浏览器串（这两条 cgi 是 h5 页面发的，不是 Kuikly）；
 * - 不做网络重试 —— 写操作重放会造成重复转发 / 重复评论；
 * - 回执既可能是 JSON / JSONP，也可能是官方 formSender 的 HTML
 *   `frameElement.callback({...})`，统一交给 {@link parseQzoneFormReply}。
 */
async function postQzoneForm(
  cred: WebCredential,
  cgi: string,
  params: Record<string, string>,
  requestText: typeof webRequestText,
): Promise<Record<string, unknown>> {
  const text = await requestText(`${FORM_CGI}/${cgi}?g_tk=${computeBkn(cred.pskey || cred.skey)}`, {
    method: 'POST',
    cookie: cookieHeader(cred),
    body: new URLSearchParams({
      code_version: '1',
      format: 'fs',
      out_charset: 'UTF-8',
      hostuin: cred.uin,
      qzreferrer: `https://user.qzone.qq.com/${cred.uin}`,
      ...params,
    }).toString(),
    headers: {
      'User-Agent': FORM_UA,
      Referer: `https://user.qzone.qq.com/${cred.uin}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });
  return parseQzoneFormReply(text);
}

export interface QzoneFeedReplyTarget {
  rootId: string;
  rootUin: string;
  uin: string;
  nickname: string;
}

/** 信息流定向回复，支持图片和独立的根评论与目标身份。 */
export async function replyQzoneFeedComment(
  cred: WebCredential,
  hostUin: string,
  tid: string,
  target: QzoneFeedReplyTarget,
  content: string,
  imageUrl?: string,
  requestText = webRequestText,
): Promise<void> {
  assertQzoneIdentity(hostUin, tid);
  if (
    !/^\d{1,20}$/.test(target.rootId) ||
    !/^[1-9]\d{4,19}$/.test(target.rootUin) ||
    !/^[1-9]\d{4,19}$/.test(target.uin)
  )
    throw new Error('请重新读取评论后选择回复目标。');
  if (!content.trim() || content.length > 4096) throw new Error('回复内容为空或过长。');
  const encodedNick = (target.nickname || target.uin).replace(
    /[%,}{:]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  const params: Record<string, string> = {
    hostUin,
    format: 'json',
    uin: cred.uin,
    topicId: `${hostUin}_${tid}__1`,
    feedsType: '100',
    commentId: target.rootId,
    commentUin: target.rootUin,
    content: `@{uin:${target.uin},nick:${encodedNick},who:1,auto:1}${content}`,
    inCharset: 'utf-8',
    outCharset: 'utf-8',
    plat: 'qzone',
    source: 'ic',
    ref: 'feeds',
    private: '0',
    paramstr: '1',
    platformid: '52',
  };
  if (imageUrl) {
    params.richtype = '1';
    params.richval = imageUrl;
  }
  const response = await postQzoneForm(cred, 'emotion_cgi_re_feeds', params, requestText);
  assertQzoneWriteAccepted(response, '回复');
}

/**
 * 转发一条说说（`tid` 属于 `hostUin`）到本账号空间。
 *
 * 语义与 WeQ 一致：转发的是**当前这条动态**，不带原帖的 `t2_tid` / `fwdtype`
 * （评论转发是另一条 cgi，本条刻意不夹带）。`reason` 为空表示不写转发语。
 *
 * `beforeSend` 由调用方注入（WeQ 用它记审计），抛错时不会发请求。
 */
export async function forwardQzoneMsg(
  cred: WebCredential,
  hostUin: string,
  tid: string,
  reason = '',
  beforeSend?: () => void,
  requestText = webRequestText,
): Promise<void> {
  assertQzoneIdentity(hostUin, tid);
  if (reason.length > 4096) throw new Error('转发语过长。');
  beforeSend?.();
  const response = await postQzoneForm(
    cred,
    'emotion_cgi_forward_v6',
    {
      tid,
      t1_uin: hostUin,
      t1_source: '1',
      signin: '0',
      con: reason,
      with_cmt: '0',
      fwdToWeibo: '0',
      forward_source: '1',
    },
    requestText,
  );
  assertQzoneWriteAccepted(response, '转发');
}
