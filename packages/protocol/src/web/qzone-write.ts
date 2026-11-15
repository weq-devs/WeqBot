/**
 * 空间写操作（P8.5）：改说说权限 / 拉黑 / 回复与转发说说。
 *
 * 搬运自 SnowLuma `protocol/src/web/qzone.ts` 的 `updateQzoneMsgRight` /
 * `setQzoneBlack` / `replyQzoneComment`，只把凭据参数换成 {@link WebCredential}、
 * 传输换成 `./http`。**写操作不做自动重试**（重放会产生重复回复或重复提交）。
 *
 * 2026-11-16 补齐 `forwardQzoneMsg`：来源 WeQ `account/web/qzone_write_actions.ts`。
 * 那条链路刻意**不引** `@babel/parser` + `parse5`，回执解析换成
 * {@link ./qzone-form-reply} 的零依赖词法扫描（行为按 WeQ 的 13 条用例对齐）。
 */

import { computeBkn, cookieHeader, WebAuthError, type WebCredential } from './credential';
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
  conlist?: Array<{ con?: string }> | null;
  pic?: RawDetailPic[] | null;
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
    { cookie: cookieHeader(cred), headers: { Referer: `https://user.qzone.qq.com/${hostUin}` } },
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

/** 拉黑 / 解除拉黑某人（作用在本账号空间）。 */
export async function setQzoneBlack(
  cred: WebCredential,
  targetUin: string,
  ban: boolean,
): Promise<void> {
  if (!/^[1-9]\d*$/.test(targetUin)) throw new Error('targetUin 必须是正整数');
  const text = await webRequestText(
    `https://h5.qzone.qq.com/proxy/domain/w.qzone.qq.com/cgi-bin/right/cgi_black_action_new?g_tk=${computeBkn(cred.pskey || cred.skey)}`,
    {
      method: 'POST',
      cookie: cookieHeader(cred),
      body: new URLSearchParams({
        uin: cred.uin,
        act_uin: targetUin,
        action: ban ? '1' : '2',
        fupdate: '1',
        qzreferrer: `https://user.qzone.qq.com/${cred.uin}/main`,
      }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    },
  );
  const data = parseQzoneJson<{ code?: number; subcode?: number; message?: string; msg?: string }>(
    text.replace(/\{\s*name\s*:/, '{"name":'),
  );
  const verb = ban ? '拉黑' : '解除拉黑';
  if (typeof data.subcode === 'number' && data.subcode !== 0) {
    throw new Error(
      `空间${verb}失败：subcode=${data.subcode} ${data.message ?? data.msg ?? ''}`.trim(),
    );
  }
  if (typeof data.code === 'number' && data.code !== 0) {
    throw new Error(`空间${verb}失败：code=${data.code} ${data.message ?? data.msg ?? ''}`.trim());
  }
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
): Promise<Record<string, unknown>> {
  const text = await webRequestText(
    `${FORM_CGI}/${cgi}?g_tk=${computeBkn(cred.pskey || cred.skey)}`,
    {
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
    },
  );
  return parseQzoneFormReply(text);
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
): Promise<void> {
  assertQzoneIdentity(hostUin, tid);
  if (reason.length > 4096) throw new Error('转发语过长。');
  beforeSend?.();
  const response = await postQzoneForm(cred, 'emotion_cgi_forward_v6', {
    tid,
    t1_uin: hostUin,
    t1_source: '1',
    signin: '0',
    con: reason,
    with_cmt: '0',
    fwdToWeibo: '0',
    forward_source: '1',
  });
  assertQzoneWriteAccepted(response, '转发');
}
