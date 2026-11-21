/**
 * 空间资料、个人档与说说删除。
 *
 * 搬运自 SnowLuma `packages/protocol/src/web/qzone.ts`（2026-11-14，用户已授权
 * 抄 wire 形状与业务逻辑），只把 cookie 参数换成本包的 {@link WebCredential}、
 * 传输换成 {@link webRequestText}。
 *
 * 写路径与读路径的差别：写 cgi 失败**不重放**（避免重复删除/重复改资料），
 * 只抛错；票据类错码统一抛 {@link WebAuthError}，调用方需要时可自行换票。
 */

import { computeBkn, cookieHeader, WebAuthError, type WebCredential } from './credential';
import { webRequestText } from './http';
import { assertQzoneWriteAccepted, parseQzoneFormReply } from './qzone-form-reply';
import { parseQzoneJson } from './qzone';

/** 空间风控 / 票据失效的通用错误码。 */
const AUTH_CODES = new Set([-3000, -10000]);

function codeError(what: string, code: number, subcode?: number, message?: string): Error {
  const text = `${what}失败：code=${code}${subcode ? ` subcode=${subcode}` : ''}${
    message ? ` ${message}` : ''
  }`.trim();
  return AUTH_CODES.has(code) ? new WebAuthError(text, code) : new Error(text);
}

interface RawQzoneProfileResponse {
  code?: number;
  subcode?: number;
  message?: string;
  data?: Record<string, unknown>;
}

export interface QzoneProfile {
  name: string;
  description: string;
  relationship?: string;
  personal: {
    nickname?: string;
    signature?: string;
    gender?: string;
    age?: number;
    birthday?: string;
    constellation?: string;
    region?: string;
    hometown?: string;
    bloodType?: string;
    occupation?: string;
    company?: string;
    companyRegion?: string;
    companyAddress?: string;
  };
}

export interface QzoneProfilePatch {
  name?: string;
  description?: string;
}

function profileText(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}

function profileNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value;
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) ? parsed : undefined;
}

function profileBirthday(data: Record<string, unknown>, own: boolean) {
  if (profileNumber(data.birthday_type) !== 0 || typeof data.birthday !== 'string')
    return undefined;
  const date = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.exec(data.birthday);
  if (!date) return undefined;
  const month = Number(date[1]);
  const day = Number(date[2]);
  const lunar = profileNumber(data.islunar) === 1;
  if (!lunar || !own) {
    return `${month}月${day}日${lunar ? '（农历）' : ''}`;
  }
  // 个人档对自己返回对应的公历日期，对访客直接返回农历月日。
  const year = profileNumber(data.birthyear);
  if (year === undefined || year < 1000 || year > 9999) return undefined;
  const birthday = new Date(Date.UTC(year, month - 1, day));
  if (birthday.getUTCDate() !== day) return undefined;
  const parts = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', {
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).formatToParts(birthday);
  const lunarMonth = parts.find((part) => part.type === 'month')?.value;
  const lunarDay = parts.find((part) => part.type === 'day')?.value;
  return lunarMonth && lunarDay ? `${lunarMonth}${lunarDay}日（农历）` : undefined;
}

const constellations = [
  '白羊座',
  '金牛座',
  '双子座',
  '巨蟹座',
  '狮子座',
  '处女座',
  '天秤座',
  '天蝎座',
  '射手座',
  '摩羯座',
  '水瓶座',
  '双鱼座',
];

export function parseQzoneProfile(text: string, own: boolean): QzoneProfile {
  const response = parseQzoneJson<RawQzoneProfileResponse>(text);
  if (response.code !== 0 || (response.subcode !== undefined && response.subcode !== 0)) {
    throw codeError('空间资料', response.code ?? 0, response.subcode, response.message);
  }
  const data = response.data;
  if (typeof data?.spacename !== 'string' || typeof data.desc !== 'string') {
    throw new Error('空间资料响应缺少名称或说明');
  }
  const num = (key: string) => profileNumber(data[key]);
  const address = (...keys: string[]) =>
    keys
      .map((key) => profileText(data[key]))
      .filter(Boolean)
      .join(' ') || undefined;
  const age = num('age');
  const relationship = ['', '单身', '已婚', '保密', '恋爱中', '已订婚', '分居', '离异'][
    num('marriage') ?? -1
  ];
  return {
    name: data.spacename,
    description: data.desc,
    ...(relationship ? { relationship } : {}),
    personal: {
      nickname: profileText(data.nickname),
      signature: profileText(data.signature),
      gender: num('sex_type') === 0 ? [undefined, '男', '女'][num('sex') ?? -1] : undefined,
      age: num('age_type') === 0 && age !== undefined && age >= 0 ? age : undefined,
      birthday: profileBirthday(data, own),
      constellation:
        num('constellation_type') === 0 ? constellations[num('constellation') ?? -1] : undefined,
      region: num('address_type') === 0 ? address('country', 'province', 'city') : undefined,
      hometown: num('home_type') === 0 ? address('hco', 'hp', 'hc') : undefined,
      bloodType: ['其他', 'A', 'B', 'O', 'AB', '其他'][num('bloodtype') ?? -1],
      occupation: profileText(data.career),
      company: profileText(data.company),
      companyRegion: address('cco', 'cp', 'cc'),
      companyAddress: profileText(data.cb),
    },
  };
}

/** 读空间名称、说明与个人档（默认自己）。 */
export async function getQzoneProfile(
  cred: WebCredential,
  selfUin: string,
  targetUin = selfUin,
): Promise<QzoneProfile> {
  const params = new URLSearchParams({
    uin: targetUin,
    vuin: selfUin,
    fupdate: '1',
    rd: String(Math.random()),
    g_tk: String(computeBkn(cred.pskey || cred.skey)),
  });
  const url = `https://h5.qzone.qq.com/proxy/domain/base.qzone.qq.com/cgi-bin/user/cgi_userinfo_get_all?${params}`;
  const text = await webRequestText(url, {
    method: 'GET',
    cookie: cookieHeader(cred),
    headers: { Referer: `https://user.qzone.qq.com/${selfUin}` },
  });
  return parseQzoneProfile(text, targetUin === selfUin);
}

/**
 * 改空间名称 / 说明。
 *
 * 字段位图 `mb`：名称 2048、说明 4096；只提交调用方给出的字段（其余保持原样）。
 */
export async function setQzoneProfile(
  cred: WebCredential,
  selfUin: string,
  patch: QzoneProfilePatch,
): Promise<void> {
  if (patch.name === undefined && patch.description === undefined) {
    throw new Error('至少提供 name 或 description 之一');
  }
  const params = new URLSearchParams({ uin: selfUin, pageindex: '3', fupdate: '1' });
  let bitmap = 0;
  if (patch.name !== undefined) {
    params.set('spacename', patch.name.replaceAll('\r', ''));
    bitmap |= 2048;
  }
  if (patch.description !== undefined) {
    params.set('desc', patch.description.replaceAll('\r', ''));
    bitmap |= 4096;
  }
  params.set('mb', String(bitmap));

  const url = `https://h5.qzone.qq.com/proxy/domain/w.qzone.qq.com/cgi-bin/user/cgi_apply_updateuserinfo_new?g_tk=${computeBkn(
    cred.pskey || cred.skey,
  )}`;
  const text = await webRequestText(url, {
    method: 'POST',
    cookie: cookieHeader(cred),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: `https://user.qzone.qq.com/${selfUin}`,
    },
    body: params.toString(),
  });
  const response = parseQzoneJson<RawQzoneProfileResponse>(text);
  if (response.code !== 0 || (response.subcode !== undefined && response.subcode !== 0)) {
    throw codeError('修改空间资料', response.code ?? 0, response.subcode, response.message);
  }
}

/**
 * 删除一条说说。
 *
 * 参数集按抓包（`format=fs` 不是 json）；`tid` 缺失直接拒绝，避免误删。
 */
export async function deleteQzoneMsg(
  cred: WebCredential,
  hostUin: string,
  tid: string,
): Promise<void> {
  const topic = String(tid ?? '').trim();
  if (!topic) throw new Error('tid 不能为空');
  const url = `https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_delete_v6?g_tk=${computeBkn(
    cred.pskey || cred.skey,
  )}`;
  const body = new URLSearchParams({
    hostuin: hostUin,
    tid: topic,
    t1_source: '1',
    code_version: '1',
    format: 'fs',
    qzreferrer: `https://user.qzone.qq.com/${hostUin}`,
  });
  const text = await webRequestText(url, {
    method: 'POST',
    cookie: cookieHeader(cred),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: `https://user.qzone.qq.com/${cred.uin}`,
    },
    body: body.toString(),
  });
  assertQzoneWriteAccepted(parseQzoneFormReply(text), '删除说说');
}
